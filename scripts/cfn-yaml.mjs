// Shared CloudFormation YAML loader: short-form intrinsic tags (!Ref, !Sub, ...) become their
// long-form objects ({ Ref }, { 'Fn::Sub' }, ...). Offline; no AWS access. Used by audit-infra.mjs.
import { parse } from 'yaml';

const tagPair = (name, key) => [
  { tag: '!' + name, resolve: (s) => ({ [key]: s }) },
  { tag: '!' + name, collection: 'seq', resolve: (seq) => ({ [key]: seq.toJSON() }) },
];

export const CFN_TAGS = [
  ['Ref', 'Ref'], ['Sub', 'Fn::Sub'], ['GetAtt', 'Fn::GetAtt'], ['If', 'Fn::If'], ['Equals', 'Fn::Equals'],
  ['Not', 'Fn::Not'], ['And', 'Fn::And'], ['Or', 'Fn::Or'], ['Join', 'Fn::Join'], ['Select', 'Fn::Select'],
  ['FindInMap', 'Fn::FindInMap'], ['Condition', 'Condition'],
].flatMap(([n, k]) => tagPair(n, k));

export const parseTemplate = (text) => parse(text, { customTags: CFN_TAGS });
