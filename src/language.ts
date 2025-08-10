const languagesData: {
  id: string;
  extensions: string[];
  aliases: string[];
}[] = [
  {
    "id": "javascript",
    "extensions": [".js", ".jsx", ".mjs", ".cjs"],
    "aliases": ["JavaScript", "javascript"]
  },
  {
    "id": "typescript",
    "extensions": [".ts", ".tsx"],
    "aliases": ["TypeScript", "typescript"]
  },
  {
    "id": "python",
    "extensions": [".py"],
    "aliases": ["Python", "python"]
  },
  {
    "id": "php",
    "extensions": [".php"],
    "aliases": ["PHP", "php"]
  },
  {
    "id": "vue",
    "extensions": [".vue"],
    "aliases": ["Vue", "vue"]
  }
];

const allExtensions = languagesData
  .flatMap(lang => lang.extensions)
  .map(ext => ext.replace(/^\./, '')); // remove leading dot

const uniqueExtensions = Array.from(new Set(allExtensions));

export const SUPPORTED_EXTENSIONS_REGEX = new RegExp(
  `\\.(${uniqueExtensions.join('|')})$`
);

export const SUPPORTED_GLOB_PATTERN = `**/*.{${uniqueExtensions.join(',')}}`;

export const UNSUPPORTED_GLOB_PATTERN = '**/{node_modules,.git,dist,build,coverage,out}/**';

export const LANGUAGE_IDS = languagesData.map((lang)=>{
  return {language: lang.id};
});