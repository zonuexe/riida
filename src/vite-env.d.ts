declare module "pdfjs-dist/build/pdf.worker.mjs?url" {
  const workerUrl: string;
  export default workerUrl;
}

declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare const __BUILD_DATE__: string;
