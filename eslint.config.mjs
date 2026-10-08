import tseslint from 'typescript-eslint';
export default [
  { ignores:['node_modules/**','dist/**','dist-electron/**','release/**','.local/**','.private/**','**/._*'] },
  { files:['src/**/*.{ts,tsx}','electron/**/*.ts','tests/**/*.ts','scripts/**/*.mjs'], languageOptions:{parser:tseslint.parser}, rules:{
    'no-unreachable':'error','no-dupe-keys':'error','no-async-promise-executor':'error',
    'no-constant-binary-expression':'error','no-unsafe-finally':'error','no-unexpected-multiline':'error',
    'no-template-curly-in-string':'error','valid-typeof':'error',
  } },
];
