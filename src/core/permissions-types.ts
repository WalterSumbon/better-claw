/** 单条权限规则。 */
export interface PermissionRule {
  /** 动作：允许或拒绝。 */
  action: 'allow' | 'deny';
  /** 访问类型：读、写、或读写。 */
  access: 'read' | 'write' | 'readwrite';
  /** 目标路径（支持 ${userWorkspace} 等变量，"*" 匹配所有路径）。 */
  path: string;
}

/** 单个权限组配置。 */
export interface PermissionGroupConfig {
  /** 继承的父权限组名称（默认 "admin"，即完全可读可写）。 */
  inherits?: string;
  /** 有序规则列表，从上到下依次生效，最后匹配的规则决定结果。 */
  rules?: PermissionRule[];
}

/** 工作组配置。 */
export interface WorkGroupConfig {
  /** 成员映射：userId → 权限级别（'r' 只读 / 'rw' 读写）。 */
  members: Record<string, 'r' | 'rw'>;
}

/** 权限系统完整配置。 */
export interface PermissionsConfig {
  /** 权限组定义（键为组名，值为组配置）。 */
  groups: Record<string, PermissionGroupConfig>;
  /** 工作组定义（可选）。 */
  workGroups?: Record<string, WorkGroupConfig>;
  /** 用户默认权限组（未在 profile 中指定时使用）。 */
  defaultGroup: string;
}

/** 经继承展开和变量替换后的扁平化规则链。 */
export interface ResolvedPermissions {
  /** 是否为 admin 组（无任何规则限制，完全可读可写）。 */
  isAdmin: boolean;
  /** 展平后的有序规则列表（父组规则在前，子组规则在后）。 */
  rules: ResolvedRule[];
}

/** 变量替换后的单条规则（路径已为绝对路径）。 */
export interface ResolvedRule {
  action: 'allow' | 'deny';
  access: 'read' | 'write' | 'readwrite';
  path: string;
}
