import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发模式下前端跑在 5173，后端 evoa web 跑在 8080。
// 代理 /api 与 /ws 到后端；生产构建产物由后端直接 serve。
export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			"/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
			"/ws": { target: "ws://127.0.0.1:8080", ws: true },
		},
	},
});
