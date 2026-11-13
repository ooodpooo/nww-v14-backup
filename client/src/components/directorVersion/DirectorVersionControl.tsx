/**
 * 导演版本已统一为 V2（新导演），不再提供版本切换入口。
 * 保留组件占位以兼容各处引用，渲染为空。
 */
export default function DirectorVersionControl(_props: {novelId: string; version?: "v1" | "v2"}) {
  return null;
}
