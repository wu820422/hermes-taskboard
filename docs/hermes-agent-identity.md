# Hermes 多 AI 參與與身分登記

Leo 2026-10-08 決定：同一 Task 允許本機與雲端、多模型並行；threadBinding 保留既有值，不能當成整個任務的獨占鎖。

## 實作路徑

MCP whoami → register_agent → comments.execution_identity＋Markdown attachment → sync capture/apply → TaskCard／TaskDetail 的 AI 參與者及留言模型標示。

API：POST /api/tasks/:id/comments 接受 executionIdentity。CLI：comment add --agent --model --environment --session-id --scope --state。

## 每個 Agent 的啟動流程

1. 呼叫實際端點 /api/mcp 的 whoami，確認 authenticated actor 與 local/cloud。
2. 從本平台可取得的 session/runtime metadata 確認實際 Agent、模型、session。未知模型留空；不可因 connector 名稱、操作帳號、舊留言推測模型。
3. 呼叫 register_agent { id: 精確 task ID, executionIdentity: { agent, model?, environment, sessionId, scope, state } }。
4. 回讀回傳 comment、attachment，下載 .md 確認內容。身分紀錄存在任務附件與留言，不另建第二份 Vault 進度。
5. 後續 add_comment 帶同一 executionIdentity；更新 scope/state。更換模型/session 時重新登記。模型是 client_reported，MCP 憑證確認的是連線 actor，不證明底層模型。

## 狀態語義

AI 參與者是各 actor＋agent＋environment＋session 最新的工作回報，不是即時心跳。working/waiting/completed/blocked 不會自動結案 Task。只有 Leo 結案。

## 分階段

第一版：身分及模型留言快照、多執行者回報、MCP 身分查讀與 .md 回寫、既有同步擴充。
後續：可信人類／Agent 憑證分離、受控資源鎖、Evidence Gate、Idempotency、Audit。第一版不宣稱完成這些能力。

## 來源基線

正式 repository 在登記的 Google Drive 系統資料夾。feature worktree 從 origin/main 6a79ef5 建立；1cfc578 保存現行 runtime-v2 與對應本機 Web 來源基線。這些既有 Hermes 分支差異與本次 identity commit 分開，禁止以 upstream main 覆蓋 runtime-v2 的同步修復。
