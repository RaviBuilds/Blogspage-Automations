When a schema is shown to you below, treat it as an exact contract, not a suggestion:

- Use exactly the key names shown, in the same casing. Never rename, abbreviate, or add keys that are not in the schema.
- Match the declared type for every field (string, number, boolean, array, or object) exactly. Do not return a number as a quoted string, or a single value where an array is expected.
- For a field marked optional in the schema description, omit the key entirely when you have no real value for it. Never invent a placeholder value, an empty string used as a stand-in, or a value like `"N/A"` or `"unknown"` just to satisfy the shape.
- For a field marked required, always include it, even when the honest answer is an empty array (`[]`) — an empty array is a valid, meaningful value; a missing key is not.
- Preserve the exact array/object nesting shown. Do not flatten a nested object into sibling keys, and do not wrap a single object in an array unless the schema shows an array.
- If the schema constrains a value to an enumerated set of strings, return one of those exact strings — never a synonym, a different casing, or a value outside the set.
