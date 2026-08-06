// Этап 5/Пакет 9A: минимальная декларация типов для bwip-js (пакет поставляет типы через exports,
// но текущая резолюция их не подхватывает). Используем только toSVG/toBuffer для Code 128.
declare module "bwip-js" {
  interface BwipOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    includetext?: boolean;
    textxalign?: string;
    paddingwidth?: number;
    paddingheight?: number;
    backgroundcolor?: string;
    [key: string]: unknown;
  }
  const bwipjs: {
    toSVG(opts: BwipOptions): string;
    toBuffer(opts: BwipOptions): Promise<Buffer>;
  };
  export default bwipjs;
}
