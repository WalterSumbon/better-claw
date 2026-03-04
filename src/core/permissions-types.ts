/**
 * 文件系统访问规则。直接映射 SDK sandbox filesystem 设置。
 *
 * SDK sandbox 支持三个文件系统数组：
 *
 * - **allowWrite**（写入白名单）：指定后，写入变为默认拒绝——
 *   只有列出的路径（及其子路径）可写。未指定时默认允许写入所有路径。
 * - **denyWrite**（写入黑名单）：进一步限制写入。可在 allowWrite 允许的目录下
 *   挖掉特定子路径的写权限。denyWrite 优先级高于 allowWrite。
 * - **denyRead**（读取黑名单）：拒绝读取。SDK 不存在 allowRead 机制——
 *   一旦父路径被 deny，子路径无法在 sandbox 层面豁免。
 *
 * canUseTool 回调（工具级 Read/Write/Edit/Glob/Grep 检查）和 SDK sandbox
 * （OS 级 Bash 隔离）使用相同的三个数组。
 *
 * 支持的路径变量（运行时替换为绝对路径）：
 *   ${userDir}       — 当前用户数据目录（<dataDir>/users/<userId>/）
 *   ${userWorkspace} — 当前用户工作区（<dataDir>/users/<userId>/workspace/）
 *   ${dataDir}       — 全局数据目录
 *   ${home}          — 系统用户主目录
 *   ${configFile}    — 配置文件路径（未从文件加载时自动跳过该条目）
 *   ${otherUserDir}  — 展开为所有其他用户的目录（每个用户一条路径）
 */
export interface FilesystemConfig {
  /** 写入白名单。指定后进入白名单模式：仅列出的路径可写，其他路径默认拒绝写入。 */
  allowWrite?: string[];
  /** 写入黑名单。在 allowWrite 基础上进一步收紧，优先级高于 allowWrite。 */
  denyWrite?: string[];
  /** 读取黑名单。列入的路径及其子路径不可读。无 allowRead 对应机制。 */
  denyRead?: string[];
}

/** 单个权限组配置。 */
export interface PermissionGroupConfig {
  /** 继承的父权限组名称（默认 "admin"，即无任何限制）。 */
  inherits?: string;
  /** 文件系统访问规则。 */
  filesystem?: FilesystemConfig;
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

/**
 * 经继承展开、变量替换和工作组合并后的最终权限。
 *
 * filesystem 中的三个数组已全部解析为绝对路径，可直接用于
 * canUseTool 回调和 SDK sandbox filesystem 配置。
 */
export interface ResolvedPermissions {
  /** 是否为 admin 组（无任何限制）。 */
  isAdmin: boolean;
  /** 已解析的文件系统访问规则（路径均为绝对路径）。 */
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
  };
  /** 受保护路径——始终拒绝读写，不可被其他规则覆盖。 */
  protectedPaths: string[];
}
