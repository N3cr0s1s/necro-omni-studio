import type { languages } from 'monaco-editor/editor/editor.api.js';

/**
 * GLSL ES 3.0, as a Monarch grammar — issue #35.
 *
 * Monaco ships no GLSL. `cpp` is the usual substitute and is wrong in the ways that matter here: it
 * highlights `float` and misses `vec3`, knows `class` and not `sampler2D`, and says nothing about the
 * built-in functions that make up most of a shader body. A shader would be coloured *almost* right,
 * which is worse than plainly — the eye learns to trust it and then it lies.
 *
 * Written as data so the vocabulary can grow: adding a built-in is a string in a list, not a change
 * to the tokenizer.
 */

const TYPES = [
  'void',
  'bool',
  'int',
  'uint',
  'float',
  'double',
  'vec2',
  'vec3',
  'vec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'mat2',
  'mat3',
  'mat4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
  'sampler2D',
  'sampler3D',
  'samplerCube',
  'sampler2DArray',
  'isampler2D',
  'usampler2D',
  'sampler2DShadow',
  'struct',
];

const KEYWORDS = [
  'attribute',
  'const',
  'uniform',
  'varying',
  'buffer',
  'shared',
  'coherent',
  'volatile',
  'restrict',
  'readonly',
  'writeonly',
  'layout',
  'centroid',
  'flat',
  'smooth',
  'noperspective',
  'patch',
  'sample',
  'break',
  'continue',
  'do',
  'for',
  'while',
  'switch',
  'case',
  'default',
  'if',
  'else',
  'subroutine',
  'in',
  'out',
  'inout',
  'invariant',
  'precise',
  'discard',
  'return',
  'lowp',
  'mediump',
  'highp',
  'precision',
];

/**
 * The built-ins a shader body is mostly made of.
 *
 * Highlighted apart from user functions, because "is this name mine or the language's" is the
 * question you are actually asking when you read someone else's shader.
 */
const BUILTINS = [
  'radians',
  'degrees',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'pow',
  'exp',
  'log',
  'exp2',
  'log2',
  'sqrt',
  'inversesqrt',
  'abs',
  'sign',
  'floor',
  'trunc',
  'round',
  'roundEven',
  'ceil',
  'fract',
  'mod',
  'modf',
  'min',
  'max',
  'clamp',
  'mix',
  'step',
  'smoothstep',
  'isnan',
  'isinf',
  'floatBitsToInt',
  'intBitsToFloat',
  'length',
  'distance',
  'dot',
  'cross',
  'normalize',
  'faceforward',
  'reflect',
  'refract',
  'matrixCompMult',
  'outerProduct',
  'transpose',
  'determinant',
  'inverse',
  'lessThan',
  'lessThanEqual',
  'greaterThan',
  'greaterThanEqual',
  'equal',
  'notEqual',
  'any',
  'all',
  'not',
  'textureSize',
  'texture',
  'textureProj',
  'textureLod',
  'textureOffset',
  'texelFetch',
  'texelFetchOffset',
  'textureGrad',
  'dFdx',
  'dFdy',
  'fwidth',
];

/** Values the pipeline provides, which are not declared anywhere the author can see. */
const PREDEFINED = [
  'gl_FragCoord',
  'gl_FrontFacing',
  'gl_PointCoord',
  'gl_Position',
  'gl_VertexID',
  'gl_InstanceID',
];

export const GLSL_LANGUAGE_ID = 'glsl';

export const GLSL_CONFIGURATION: languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
};

export const GLSL_TOKENS: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.glsl',
  keywords: KEYWORDS,
  typeKeywords: TYPES,
  builtinFunctions: BUILTINS,
  predefined: PREDEFINED,

  operators: [
    '=',
    '>',
    '<',
    '!',
    '~',
    '?',
    ':',
    '==',
    '<=',
    '>=',
    '!=',
    '&&',
    '||',
    '++',
    '--',
    '+',
    '-',
    '*',
    '/',
    '&',
    '|',
    '^',
    '%',
    '<<',
    '>>',
    '+=',
    '-=',
    '*=',
    '/=',
    '&=',
    '|=',
    '^=',
    '%=',
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/u,

  tokenizer: {
    root: [
      // Directives first: `#version 300 es` is the first line of every assembled shader, and a `#`
      // that fell through to the identifier rule would colour `version` as a variable.
      [/^\s*#\s*\w+/u, 'keyword.directive'],

      [
        /[a-zA-Z_]\w*/u,
        {
          cases: {
            '@typeKeywords': 'type',
            '@keywords': 'keyword',
            '@builtinFunctions': 'predefined',
            '@predefined': 'variable.predefined',
            '@default': 'identifier',
          },
        },
      ],

      { include: '@whitespace' },

      [/[{}()[\]]/u, '@brackets'],
      [/@symbols/u, { cases: { '@operators': 'operator', '@default': '' } }],

      // Floats before integers, or `1.0` tokenizes as `1` then `.0`.
      [/\d*\.\d+([eE][-+]?\d+)?[fF]?/u, 'number.float'],
      [/0[xX][0-9a-fA-F]+[uU]?/u, 'number.hex'],
      [/\d+[uU]?/u, 'number'],

      [/[;,.]/u, 'delimiter'],
    ],

    whitespace: [
      [/[ \t\r\n]+/u, ''],
      [/\/\*/u, 'comment', '@comment'],
      [/\/\/.*$/u, 'comment'],
    ],

    comment: [
      [/[^/*]+/u, 'comment'],
      [/\*\//u, 'comment', '@pop'],
      [/[/*]/u, 'comment'],
    ],
  },
};
