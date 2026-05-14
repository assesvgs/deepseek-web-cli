export interface Credentials {
  /** DeepSeek 网页版的完整 Cookie 字符串，包括 d_id、ds_session_id 等 */
  cookie: string;
  /** Bearer Token，从网络请求头或 /api/v0/users/current 响应中捕获，可能为空字符串 */
  bearer: string;
  /** 浏览器 User-Agent，从登录时的 Chrome 中提取，用于后续请求伪装 */
  userAgent: string;
}