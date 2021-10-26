import {defineConfig} from "vite";
import vue from "@vitejs/plugin-vue";
import federation from "@originjs/vite-plugin-federation";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue(),
        federation({
            name: "router-host",
            filename: "remoteEntry.js",
            remotes: {
                "router-remote": "http://localhost:5005/remoteEntry.js",
            },
            shared: ["vue", "element-plus"]
        })
    ],
    optimizeDeps:{
        include: ["element-plus"]
    },
    // 解决 const Home = {template: '<p>Home</p>'} 类组件无法在 vue-router 中显示的问题
    resolve:{
        alias:{
            vue : 'vue/dist/vue.esm-bundler.js'
        }
    },
    build: {
        target: 'es2020',
        minify: false,
        cssCodeSplit: true,
        rollupOptions: {
            output: {
                minifyInternalExports: false
            },
            treeshake: false
        }
    },
});
