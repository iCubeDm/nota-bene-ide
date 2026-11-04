import { array, record } from './json.ts';

export function validateForm(content: unknown, schema: Record<string, unknown>): void {
  const c = record(content), props = record(schema.properties);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Expected a JSON object');
  for (const id of array(schema.required)) if (typeof id === 'string' && !(id in c)) throw new Error(`Missing field: ${id}`);
  for (const [id, v] of Object.entries(c)) {
    const s = record(props[id]);
    const type = s.type;
    if (!Object.hasOwn(props, id) || (type === 'array' ? !Array.isArray(v) : type === 'integer' ? !Number.isInteger(v) : typeof v !== type)) throw new Error(`Invalid field: ${id}`);
    const enumValues = array(s.enum).length ? array(s.enum) : array(s.oneOf).map((x) => record(x).const);
    if (enumValues.length && !enumValues.includes(v)) throw new Error(`Invalid option: ${id}`);
    if (typeof v === 'number' && ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum))) throw new Error(`Out of range: ${id}`);
    if (typeof v === 'string' && ((typeof s.minLength === 'number' && v.length < s.minLength) || (typeof s.maxLength === 'number' && v.length > s.maxLength))) throw new Error(`Invalid length: ${id}`);
    if (Array.isArray(v)) {
      const items = record(s.items), opts = array(items.enum).length ? array(items.enum) : array(items.anyOf).map((x) => record(x).const);
      if (v.some((x) => typeof x !== 'string' || (opts.length && !opts.includes(x))) || (typeof s.minItems === 'number' && v.length < s.minItems) || (typeof s.maxItems === 'number' && v.length > s.maxItems)) throw new Error(`Invalid selection: ${id}`);
    }
  }
}
