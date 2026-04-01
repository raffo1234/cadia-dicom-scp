declare module 'dcmjs' {
  export const data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer): {
        dict: Record<string, unknown>;
      };
    };
    DicomMetaDictionary: {
      naturalizeDataset(dataset: Record<string, unknown>): Record<string, any>;
    };
    datasetToBuffer(dataset: Record<string, unknown>): Buffer;
  };
}