# chat-lite

轻量自托管聊天界面，直连 DeepSeek API（或其他兼容 OpenAI 格式的 API）。

## 启动

```bash
cd chat-lite
npm install
node server.js
```

浏览器打开 `http://localhost:3000`

## 功能

- [x] 流式输出（SSE）
- [x] 多对话管理（新建/切换/删除）
- [x] 对话持久化（localStorage）
- [x] Markdown 渲染 + 代码高亮
- [x] 编辑用户消息（编辑后自动重链）
- [x] 编辑模型回复
- [x] 重新生成 + 版本回溯接口预留
- [x] 上传 .txt / .md / .json（透明附加上下文）
- [x] 上传 .docx 接口预留
- [x] 深度思考开关（thinking on/off）
- [x] 系统提示词（按对话独立）
- [x] 用户身份设定
- [x] API Key 界面内配置
- [x] 深色/浅色主题
- [x] 移动端适配
- [x] 原生支持 1M 上下文

## 配置

编辑 `config.json`:

- `apiKey` — DeepSeek API 密钥
- `models` — 可用模型列表
- `defaultModel` — 默认模型
- `extraParams` — 每次请求注入的额外参数

## Tailscale 访问

手机通过 Tailscale 访问 `http://<tailscale-ip>:3000`。

## 自定义参数

如需向 DeepSeek API 请求体注入自定义参数（如 `thinking: {"type": "disabled"}`），在 `config.json` 的 `extraParams` 中添加，或在界面的深度思考开关中控制。
