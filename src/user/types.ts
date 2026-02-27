/** 支持的平台类型。 */
export type PlatformType = 'telegram' | 'qq' | 'wechat' | 'cli' | 'dingtalk';

/** 用户的平台账号绑定记录。 */
export interface PlatformBinding {
  /** 平台名称。 */
  platform: PlatformType;
  /** 平台上的用户 ID。 */
  platformUserId: string;
  /** 绑定时间（ISO 8601）。 */
  boundAt: string;
}

/** 持久化的用户档案。 */
export interface UserProfile {
  /** 系统内唯一用户 ID。 */
  userId: string;
  /** 用于身份验证的 secret token。 */
  token: string;
  /** 显示名称。 */
  name: string;
  /** 已绑定的平台账号列表。 */
  bindings: PlatformBinding[];
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}
