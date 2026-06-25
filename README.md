# chat-lite

通用 OpenAI 兼容 API 聊天界面。支持任意 OpenAI 格式接口，自定义 API 地址，自动发现模型，多 Provider 管理。

## 启动

```bash
cd chat-lite
npm install
node server.js
```

浏览器打开 `http://localhost:7000`（端口在 `config.json` 中配置）。

## 功能

### 核心

- 流式输出（SSE）+ Thinking 降级
- 多对话管理（新建/切换/删除/搜索）
- 数据持久化（IndexedDB + 服务端双向同步）
- Markdown 渲染 + 代码高亮
- 分支总览 + 版本回溯（树状可视化）
- 消息编辑（用户/AI 消息均可编辑）
- 重新生成 + 继续生成
- 消息复制
- JSON 导入导出

### Provider 系统

- 多 Provider 支持（自定义 API 地址 + API Key）
- 自动发现模型列表
- 模型热切换（顶栏选择器）
- 连接测试

### 输入增强

- 文件上传（.txt / .md / .json / .csv / .js / .py / .html / .css / .xml / .yaml / .yml / .log）
- 图片上传（识图，走 vision API）
- 状态栏（模型回复末尾附加结构化信息，可自定义模板）
- 强调提示（放在系统提示词之后，增强模型遵从度）

### 角色卡

- 导入 PNG 角色卡（酒馆格式）
- 导出 PNG 角色卡
- 角色信息编辑（名称/简介/性格/场景/开场白/示例对话/系统提示词）

### 界面

- 深色/浅色主题
- 移动端适配 + PWA 支持
- 自定义对话背景图片
- 字体大小 / 行间距可调
- HTTPS 支持（PWA 安装需要）

## 配置

编辑 `config.json`：

```json
{
  "apiBaseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "models": ["model-a", "model-b"],
  "defaultModel": "model-a",
  "maxTokens": 4096,
  "temperature": 0.7,
  "extraParams": {},
  "port": 7000
}
```

`config.json` 只是默认配置。启动后可在界面的「设置 → 接口管理」中添加多个 Provider，每个 Provider 独立配置 API 地址、Key 和模型列表。

## 自定义参数

如需向 API 请求体注入额外参数（如 `thinking: {"type": "disabled"}`），在 `config.json` 的 `extraParams` 中添加，或通过界面的深度思考开关控制。

## Tailscale 访问

手机通过 Tailscale 访问 `http://<tailscale-ip>:7000`。HTTPS 模式下访问 `https://<tailscale-ip>:7001` 可安装 PWA。
