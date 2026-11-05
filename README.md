# dsh-conversation-manager

DSH（DeepSeek Harness）插件：在侧栏会话的「...」菜单里**真正删除**对话，连同磁盘上的会话数据一起清除。DSH 自带的 archive 只是把会话隐藏，本插件是真删。

## 安装

```sh
dsh plugin --profile web add github:lloggc-Dante/dsh-conversation-manager
```

装完**重启 DSH**。`--profile` 换成你实际使用的 profile 名。

卸载：

```sh
dsh plugin --profile web remove @logic-dante/dsh-conversation-manager
```

## 用法

- **删单个**：鼠标移到侧栏的会话 → 打开「...」菜单 → 点红色的「删除对话」。该行立刻从列表消失，不用刷新页面。
- **批量删**：点搜索框旁边的多选按钮 → 逐个勾选会话 → 点账户区上方的删除栏 → 二次确认后删除。

## 删除会做什么

删掉 `~/.dsh/sessions/<项目>/<session-id>/` 整个目录（含 `session.v4.jsonl.zstd` 日志）和 `storages/session_projcache` 里的缓存记录，并把这个 id 从所有工作区、归档与置顶列表里摘除。

**不可恢复，没有回收站。** 删除前会先停掉这个对话正在跑的工作；如果文件还被占用，会提示你先切到别的对话再删。

## 兼容性

需要 DSH 的 web 端（`dsh.client.platform: web`）。插件依赖 `connection.fetch` 路由和 `workspaceRegistry` / `sessionPersistence` 两个服务。

## English

Deletes a conversation from its sidebar "..." menu — for real, not an archive. Install with:

```sh
dsh plugin --profile web add github:lloggc-Dante/dsh-conversation-manager
```

Restart DSH afterwards. The red "Delete conversation" row removes the session directory and log, the projection-cache record, and the id from every workspace, archive and pin list. Multi-select delete lives behind the toggle beside the search box and asks for confirmation. Deletion is permanent — there is no trash.
