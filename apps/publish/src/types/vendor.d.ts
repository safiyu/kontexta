// Minimal ambient declarations for third-party packages with no bundled
// types and no @types package on npm. Kept intentionally loose (`any`) —
// only the surface area actually used here is exercised.

declare module "pdfmake" {
  interface PdfMakeDoc {
    getBuffer(): Promise<Buffer>;
  }
  interface VirtualFs {
    writeFileSync(filename: string, content: Buffer): void;
    existsSync(filename: string): boolean;
  }
  interface PdfMake {
    virtualfs: VirtualFs;
    setFonts(fonts: Record<string, unknown>): void;
    createPdf(docDefinition: Record<string, unknown>): PdfMakeDoc;
  }
  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module "html-to-pdfmake" {
  function htmlToPdfmake(html: string, options?: Record<string, unknown>): unknown[];
  export default htmlToPdfmake;
}
