declare module 'dcmjs' {
  export const data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer): {
        dict: Record<string, unknown>;
      };
    };
    DicomMetaDictionary: {
      naturalizeDataset(dataset: Record<string, unknown>): Record<string, any>;
      denaturalizeDataset(dataset: Record<string, unknown>): Record<string, any>;
    };
    DicomDict: new (meta: Record<string, any>) => {
      dict: Record<string, any>;
      write(): ArrayBuffer;
    };
    datasetToBuffer(dataset: Record<string, unknown>): Buffer;
  };
}