import { PluginHooks } from '../types/pluginHooks'
import { findDependencies, getModuleMarker, parseOptions } from './utils'
import {
  builderInfo,
  EXPOSES_CHUNK_SET,
  EXPOSES_MAP,
  parsedOptions,
  ROLLUP
} from './public'
import MagicString from 'magic-string'
import { walk } from 'estree-walker'
import path from 'path'
import {
  ConfigTypeSet,
  VitePluginFederationOptions,
  SharedRuntimeInfo
} from 'types'
import { OutputAsset, OutputChunk, RenderedChunk } from 'rollup'

export let provideShared: (string | (ConfigTypeSet & SharedRuntimeInfo))[]

export function sharedPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  parsedOptions.shared = provideShared = parseOptions(
    options.shared || {},
    () => ({
      import: true,
      shareScope: 'default'
    }),
    (value) => {
      value.import = value.import ?? true
      value.shareScope = value.shareScope || 'default'
      return value
    }
  ) as (string | (ConfigTypeSet & SharedRuntimeInfo))[]
  const sharedNames = new Set<string>()
  provideShared.forEach((value) => sharedNames.add(value[0]))
  const exposesModuleIdSet = new Set()
  EXPOSES_MAP.forEach((value) => {
    exposesModuleIdSet.add(`${value}.js`)
  })
  let isHost
  let isRemote

  return {
    name: 'originjs:shared',
    virtualFile: {
      __rf_fn__import: `
      const moduleMap= ${getModuleMarker('moduleMap', 'var')}
      const sharedInfo = ${getModuleMarker('sharedInfo', 'var')}
      let errorMessage = [];
      async function importShared(name,shareScope = 'default') {
        if (errorMessage.length) {
          errorMessage = []
        }
        const providerModule = await getProviderSharedModule(name,shareScope);
        if (providerModule) {
          return providerModule
        } else {
          const consumerModule = await getConsumerSharedModule(name);
          if(consumerModule){
            return consumerModule
          }else {
            throw Error(errorMessage.join(','))
          }
        }
      }
      async function getProviderSharedModule(name,shareScope) {
        if (globalThis?.__rf_var__shared?.[shareScope]?.[name]) {
          const dep = globalThis.__rf_var__shared[shareScope][name];
          if (sharedInfo[name]?.requiredVersion) {
            // judge version satisfy
            const satisfies = await import('semver/functions/satisfies');
            const fn = satisfies.default||satisfies
            if (fn(dep.version, sharedInfo[name].requiredVersion)) {
              return dep.get()
            } else {
              errorMessage.push(\`provider support \${name}(\${dep.version}) is not satisfied requiredVersion(\${sharedInfo[name].requiredVersion})\`)
            }
          } else {
            return dep.get() 
          }
        }
      }
      async function getConsumerSharedModule(name) {
        if (sharedInfo[name]?.import) {
          return import(moduleMap[name])
        } else {
          errorMessage.push(\`consumer config import=false,so cant use callback shared module\`)
        }
      }
      export {importShared as default};
      `
    },
    options(inputOptions) {
      isHost = !!parsedOptions.remotes.length
      isRemote = !!parsedOptions.exposes.length
      if (sharedNames.size) {
        // remove item which is both in external and shared
        inputOptions.external = (inputOptions.external as [])?.filter(
          (item) => {
            return !sharedNames.has(item)
          }
        )
        // add shared content into input
        sharedNames.forEach((shareName) => {
          inputOptions.input![`${getModuleMarker(shareName, 'input')}`] =
            shareName
          if (Array.isArray(inputOptions.external)) {
            inputOptions.external.push(
              getModuleMarker(`\${${shareName}}`, 'shareScope')
            )
          }
        })
      }
      return inputOptions
    },

    async buildStart() {
      for (const arr of provideShared) {
        const id = await this.resolveId(arr[0])
        arr[1].id = id
        if (isHost && !arr[1].version) {
          const regExp = new RegExp(`node_modules[/\\\\]${arr[0]}[/\\\\]`)
          const packageJsonPath = `${id?.split(regExp)[0]}node_modules/${
            arr[0]
          }/package.json`
          try {
            arr[1].version = (await import(packageJsonPath)).version
            arr[1].version.length
          } catch (e) {
            this.error(
              `No description file or no version in description file (usually package.json) of ${arr[0]}(${packageJsonPath}). Add version to description file, or manually specify version in shared config.`
            )
          }
        }
      }
      if (provideShared.length && isRemote) {
        this.emitFile({
          fileName: `${
            builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
          }__rf_fn__import.js`,
          type: 'chunk',
          id: '__rf_fn__import',
          preserveSignature: 'strict'
        })
      }
    },

    outputOptions: function (outputOption) {
      const that = this
      const priority: string[] = []
      const depInShared = new Map()
      provideShared.forEach((value) => {
        const shareName = value[0]
        // pick every shared moduleId
        const usedSharedModuleIds = new Set<string>()
        const sharedModuleIds = new Map<string, string>()
        // exclude itself
        provideShared
          .filter((item) => item[0] !== shareName)
          .forEach((item) => sharedModuleIds.set(item[1].id, item[0]))
        depInShared.set(shareName, usedSharedModuleIds)
        const deps = new Set<string>()
        findDependencies.apply(that, [
          value[1].id,
          deps,
          sharedModuleIds,
          usedSharedModuleIds
        ])
        value[1].dependencies = deps
      })
      // judge dependencies priority
      const orderByDepCount: Map<string, Set<string>>[] = []
      depInShared.forEach((value, key) => {
        if (!orderByDepCount[value.size]) {
          orderByDepCount[value.size] = new Map()
        }
        orderByDepCount[value.size].set(key, value)
      })

      // dependency nothing is first
      for (let i = 0; i < orderByDepCount.length; i++) {
        if (i === 0) {
          for (const key of orderByDepCount[i].keys()) {
            priority.push(key)
          }
        } else {
          for (const entries of orderByDepCount[i].entries()) {
            addDep(entries, priority, depInShared)
          }
        }
      }

      function addDep([key, value], priority, depInShared) {
        for (const dep of value) {
          if (!priority.includes(dep)) {
            addDep([dep, depInShared.get(dep)], priority, depInShared)
          }
        }
        if (!priority.includes(key)) {
          priority.push(key)
        }
      }

      // adjust the map order according to priority
      provideShared.sort((a, b) => {
        const aIndex = provideShared.findIndex((value) => value[0] === a[0])
        const bIndex = provideShared.findIndex((value) => value[0] === b[0])
        return aIndex - bIndex
      })

      // only active when manualChunks is function,array not to solve
      if (typeof outputOption.manualChunks === 'function') {
        outputOption.manualChunks = new Proxy(outputOption.manualChunks, {
          apply(target, thisArg, argArray) {
            const id = argArray[0]
            //  if id is in shared dependencies, return id ,else return vite function value
            const find = provideShared.find((arr) =>
              arr[1].dependencies.has(id)
            )
            return find ? find[0] : target(argArray[0], argArray[1])
          }
        })
      }
      return outputOption
    },

    generateBundle: function (options, bundle) {
      // Find out the real shared file
      let sharedImport: RenderedChunk | undefined
      for (const fileName in bundle) {
        const chunk = bundle[fileName]
        if (chunk.type === 'chunk' && chunk.isEntry) {
          const sharedName = chunk.name.match(/(?<=__rf_input__).*/)?.[0]
          if (sharedName) {
            let filePath = ''
            if (Object.keys(chunk.modules).length) {
              filePath = chunk.fileName
            } else {
              if (chunk.imports.length === 1) {
                filePath = chunk.imports[0]
              } else if (chunk.imports.length > 1) {
                filePath =
                  chunk.imports.find(
                    (item) => bundle[item].name === sharedName
                  ) ?? ''
              }
            }
            const fileName = path.basename(filePath)
            const fileDir = path.dirname(filePath)
            const sharedProp = provideShared.find(
              (item) => sharedName === item[0]
            )?.[1]
            if (sharedProp) {
              sharedProp.fileName = fileName
              sharedProp.fileDir = fileDir
              sharedProp.filePath = filePath
            }
          } else {
            // record the __rf_fn_import chunk
            if (chunk.name === getModuleMarker('import', 'fn')) {
              sharedImport = chunk
            }
          }
        }
      }

      const importReplaceMap = new Map()
      // rename file and remove unnecessary file
      provideShared.forEach((arr) => {
        const sharedName = arr[0]
        const sharedProp = arr[1]
        const { fileName, fileDir, filePath } = sharedProp
        if (filePath && !fileName.startsWith('__rf_input')) {
          const expectName = `__rf_input__${sharedName}`
          let expectFileName = ''
          // find expectName
          for (const file in bundle) {
            if (bundle[file].name === expectName) {
              expectFileName = path.basename(bundle[file].fileName)
              break
            }
          }
          expectFileName = expectFileName ? expectFileName : `${expectName}.js`
          // rollup fileName
          const expectFilePath = `${fileDir}/${expectFileName}`
          // fileName or filePath,vite is filePath,rollup is filename
          const expectFileNameOrPath =
            builderInfo.builder === ROLLUP ? expectFileName : expectFilePath
          const fileNameOrPath =
            builderInfo.builder === ROLLUP ? fileName : filePath
          // delete non-used chunk
          delete bundle[expectFileNameOrPath]
          //  rename chunk
          bundle[expectFileNameOrPath] = bundle[fileNameOrPath]
          bundle[expectFileNameOrPath].fileName = expectFileNameOrPath
          sharedProp.chunk = bundle[expectFileNameOrPath]
          delete bundle[fileNameOrPath]
          importReplaceMap.set(filePath, expectFilePath)
          sharedProp.fileName = expectFileName
        } else {
          sharedProp.chunk =
            bundle[builderInfo.builder === ROLLUP ? fileName : filePath]
        }
        sharedProp.filePath =
          '/' +
          `${sharedProp.fileDir}/${sharedProp.fileName}`.replace(/^\.?\//, '')
        importReplaceMap.set(
          getModuleMarker(`\${${sharedName}}`, 'shareScope'),
          `./${sharedProp.fileName}`
        )
      })

      // replace every chunk import
      importReplaceMap.forEach((value, key) => {
        for (const fileKey in bundle) {
          const chunk = bundle[fileKey]
          if (chunk.type === 'chunk') {
            const importIndexOf = chunk.imports.indexOf(key)
            if (importIndexOf >= 0) {
              chunk.imports[importIndexOf] = value
              chunk.code = chunk.code.replace(
                path.basename(key),
                path.basename(value)
              )
            }
            chunk.code = chunk.code.replace(key, value)
          }
        }
      })

      if (EXPOSES_CHUNK_SET.size && provideShared.length) {
        const moduleMapCode = `{${[...provideShared]
          .map((item) => `'${item[0]}':'${item[1].filePath}'`)
          .join(',')}}`
        if (sharedImport) {
          sharedImport.code = sharedImport.code?.replace(
            getModuleMarker('moduleMap', 'var'),
            moduleMapCode
          )
          const obj = {}
          // only need little field
          provideShared.forEach(
            (value) =>
              (obj[value[0]] = {
                import: value[1].import,
                requiredVersion: value[1].requiredVersion
              })
          )
          sharedImport.code = sharedImport.code?.replace(
            getModuleMarker('sharedInfo', 'var'),
            JSON.stringify(obj)
          )
        }
        // add dynamic import
        const FN_IMPORT = getModuleMarker('import', 'fn')
        const needDynamicImportChunks = new Set(
          [...provideShared]
            .map((item) => item[1].chunk)
            .concat(EXPOSES_CHUNK_SET)
        )
        EXPOSES_CHUNK_SET.forEach((exposeChunk) => {
          findNeedChunks(exposeChunk)
        })

        // eslint-disable-next-line no-inner-declarations
        function findNeedChunks(
          chunk: OutputChunk | OutputAsset | RenderedChunk
        ): void {
          if (chunk?.type === 'chunk') {
            chunk.imports?.forEach((importTarget) => {
              findNeedChunks(bundle[importTarget])
            })
            if (!needDynamicImportChunks.has(chunk)) {
              needDynamicImportChunks.add(chunk)
            }
          }
        }

        needDynamicImportChunks.forEach((chunk) => {
          if (chunk.code) {
            let lastImport: any = null
            const ast = this.parse(chunk.code)
            const importMap = new Map()
            const magicString = new MagicString(chunk.code!)
            walk(ast, {
              enter(node: any) {
                if (node.type === 'ImportDeclaration') {
                  const fileName = path.basename(node.source.value)
                  const sharedItem = provideShared.find(
                    (arr) => arr[1].fileName === fileName
                  )
                  const sharedName = sharedItem?.[0]
                  if (sharedName) {
                    importMap.set(sharedName, {
                      source: node.source.value,
                      specifiers: node.specifiers,
                      sharedItem: sharedItem?.[1]
                    })
                    //  replace import with empty
                    magicString.overwrite(node.start, node.end, '')
                  }
                  // record the last import to insert dynamic import code
                  lastImport = node
                }
              }
            })
            //  generate variable declare
            const PLACEHOLDER_VAR = [...importMap.entries()]
              .map(([key, value]) => {
                let str = ''
                value.specifiers?.forEach((space) => {
                  str += `,${
                    space.imported.name === space.local.name
                      ? ''
                      : `${space.imported.name}:`
                  }${space.local.name}`
                })
                const sharedScope = value.sharedItem.shareScope
                if (str) {
                  return `const {${str.substring(
                    1
                  )}} = await ${FN_IMPORT}('${key}'${
                    sharedScope === 'default' ? '' : `,'${sharedScope}'`
                  });`
                }
              })
              .join('')
            if (PLACEHOLDER_VAR) {
              //  append code after lastImport
              magicString.prepend(
                `\n import ${FN_IMPORT} from './${FN_IMPORT}.js'\n`
              )
              magicString.appendRight(lastImport.end, PLACEHOLDER_VAR)
            }
            chunk.code = magicString.toString()
          }
        })
      }
    }
  }
}
