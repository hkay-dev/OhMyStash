// termcut ships TypeScript sources that import its generated assets with `type: "file"`; these resolve to paths.
declare module "*/generated/page.js" {
  const path: string;
  export default path;
}
declare module "*/generated/player.js" {
  const path: string;
  export default path;
}
declare module "*.css" {
  const path: string;
  export default path;
}
declare module "*.wasm" {
  const path: string;
  export default path;
}
