import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default [
  ...nextVitals,
  ...nextTs,
  { ignores: ['node_modules/**', '.next/**', 'coverage/**', 'next-env.d.ts'] },
];
