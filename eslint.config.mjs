import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  // data/ is local-only (test kit, one-off loaders, handover copies) and git-ignored: it never ships.
  { ignores: ["node_modules/**", ".next/**", "next-env.d.ts", "data/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
