declare function findCustomPropertyDefinitions(
  cssAssets: any[]
): Record<string, Array<{ value: string; [key: string]: any }>>;
export = findCustomPropertyDefinitions;
