// The bundler's dataurl loader turns font imports into data URLs.
declare module "*.woff2" {
  const url: string;
  export default url;
}
