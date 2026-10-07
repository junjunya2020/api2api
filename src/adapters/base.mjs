/**
 * 适配器基类。
 *
 * 设计原则（用户明确要求）：**不转换协议**。
 * 适配器只负责三件事：
 *   1. 拼上游 URL
 *   2. 拼上游 Header（把 Key 塞进 Authorization）
 *   3. 把上游的错误响应**识别**成统一错误分类（用于调度决策）
 *
 * 请求体与成功响应**字节级原样透传**，适配器不碰。
 */
import { ErrClass, classifyByStatus } from '../util/errors.mjs';

export class BaseAdapter {
  /** @param {{id:string, displayName:string, defaultBaseUrl:string}} opts */
  constructor(opts) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.defaultBaseUrl = opts.defaultBaseUrl;
  }

  /** 去掉尾部斜杠的 base */
  norm(baseUrl) {
    return String(baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  /** 上游 chat completions 端点 */
  chatUrl(baseUrl) {
    return `${this.norm(baseUrl)}/chat/completions`;
  }

  /** 上游 models 端点（测活用） */
  modelsUrl(baseUrl) {
    return `${this.norm(baseUrl)}/models`;
  }

  /** 拼 Header。默认 Bearer；子类可覆盖 */
  headers(secret, extra = null) {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      Accept: '*/*',
      'User-Agent': 'api2api/0.1',
    };
    if (extra && typeof extra === 'object') Object.assign(h, extra);
    return h;
  }

  /**
   * 判定一次上游响应。
   * @returns {{ errClass:string, message:string, code:string|number|null, traceId:string|null }}
   * 子类覆盖 tryParseError 来解析各自的错误壳。
   *
   * 兜底策略（2026-10-06 真 Key 实测修正）：
   *   适配器解析不出明确分类时返回 TRANSIENT（"我不确定"）。
   *   但 HTTP 状态码本身是强信号 —— 若状态能给出更具体的分类
   *   （429→quota / 401,403→auth / 404→config_fault），以状态为准。
   *   实例：商汤 429 `RateLimitExceeded.EndpointRPMExceeded` 曾被误判为 transient。
   */
  classify(status, _headersObj, bodyText) {
    if (status >= 200 && status < 300) {
      return { errClass: ErrClass.OK, message: '', code: null, traceId: null };
    }
    const byStatus = classifyByStatus(status);
    const parsed = this.tryParseError(bodyText);

    if (!parsed) {
      return {
        errClass: byStatus,
        message: bodyText ? bodyText.slice(0, 500) : `HTTP ${status}`,
        code: null,
        traceId: null,
      };
    }

    // 适配器只给出"不确定"的 TRANSIENT，而 HTTP 状态更具体 → 信任状态码
    if (parsed.errClass === ErrClass.TRANSIENT && byStatus !== ErrClass.TRANSIENT) {
      return { ...parsed, errClass: byStatus };
    }
    return parsed;
  }

  /** 子类实现：从 body 文本里抽出错误信息。返回 null 表示"不是我能识别的壳" */
  tryParseError(_bodyText) {
    return null;
  }

  /** 从上游 /v1/models 响应里抽出模型 id 列表 */
  parseModels(json) {
    if (!json || !Array.isArray(json.data)) return [];
    return json.data.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  }
}

export default BaseAdapter;
