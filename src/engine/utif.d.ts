// The parts of UTIF (MIT, photopea/UTIF.js) the TIFF reader uses.
declare module 'utif' {
  const UTIF: {
    decode(buffer: ArrayBuffer): object[];
    decodeImage(buffer: ArrayBuffer, ifd: object): void;
    toRGBA8(ifd: object): Uint8Array;
  };
  export default UTIF;
}
