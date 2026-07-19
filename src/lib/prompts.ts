/**
 * Prompt loading, partial resolution, role composition, and variable
 * interpolation mechanics that sit underneath the Prompt Registry.
 *
 * Every function here is pure with respect to I/O: reading raw file content
 * is delegated to an injected {@link PromptFileSource}, so this module never
 * touches the filesystem, a provider, or any pipeline module directly.
 */

/** The five documented prompt file roles. */
export type PromptFileRole = 'system' | 'user' | 'examples' | 'validation' | 'repair';

/** Prompt roles that must exist for every prompt-bearing registry key. */
export const REQUIRED_PROMPT_ROLES: readonly PromptFileRole[] = ['system', 'user'];

/** Prompt roles that only some registry keys provide. */
export const OPTIONAL_PROMPT_ROLES: readonly PromptFileRole[] = [
  'examples',
  'validation',
  'repair',
];

/** Maps an optional role to the special placeholder it fills inside user.md. */
const ROLE_PLACEHOLDER: Readonly<Record<'examples' | 'validation' | 'repair', string>> = {
  examples: 'examples',
  validation: 'rubric',
  repair: 'repairInstructions',
};

const RESERVED_VARIABLE_NAMES: readonly string[] = Object.values(ROLE_PLACEHOLDER);

/** Resolution context threaded through the tenant/locale override chain. */
export interface PromptResolutionContext {
  readonly tenantId?: string;
  readonly locale?: string;
}

/** Which tier of the override chain a resolved file came from. */
export type PromptResolutionTier = 'base' | 'locale' | 'tenant' | 'tenant-locale';

/**
 * Reads raw prompt file content by logical, root-relative, forward-slash path
 * (for example `writer/system.md` or `shared/brand-voice.md`). Implementations
 * must not apply their own caching; {@link PromptRegistry} owns caching via
 * `AsyncCache`.
 */
export interface PromptFileSource {
  fileExists(logicalPath: string): Promise<boolean>;
  readFile(logicalPath: string): Promise<string>;
}

/** One structural or content defect found while resolving a prompt set. */
export interface PromptValidationIssue {
  readonly kind:
    | 'missing-file'
    | 'missing-partial'
    | 'circular-partial'
    | 'unresolved-variable'
    | 'unused-variable'
    | 'role-placeholder-mismatch'
    | 'duplicate-placeholder'
    | 'reserved-variable-name'
    | 'misplaced-role-placeholder';
  readonly message: string;
}

/** Where one resolved role's content actually came from. */
export interface PromptSourceInfo {
  readonly role: PromptFileRole;
  readonly logicalPath: string;
  readonly tier: PromptResolutionTier;
}

/** One shared-fragment inclusion, in encounter order. */
export interface IncludedFragment {
  readonly logicalPath: string;
  readonly includedFrom: string;
}

/** Everything resolved for one registry key, valid or not. */
export interface PromptResolution {
  readonly system: string | undefined;
  readonly user: string | undefined;
  readonly examples: string | undefined;
  readonly validation: string | undefined;
  readonly repair: string | undefined;
  readonly sources: readonly PromptSourceInfo[];
  readonly includedFragments: readonly IncludedFragment[];
  readonly referencedVariables: readonly string[];
  readonly suppliedVariables: readonly string[];
  readonly missingVariables: readonly string[];
  readonly unusedVariables: readonly string[];
  readonly issues: readonly PromptValidationIssue[];
  readonly valid: boolean;
}

/** Raised internally to unwind partial expansion; never crosses this module's boundary. */
class PartialResolutionFailure extends Error {
  public constructor(public readonly issue: PromptValidationIssue) {
    super(issue.message);
  }
}

const PARTIAL_REFERENCE_PATTERN = /\{\{>\s*([^{}\s]+)\s*\}\}/g;
const VARIABLE_REFERENCE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const SAFE_PARTIAL_PATH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/_-]*\.md$/;

function isSafePartialReference(reference: string): boolean {
  return !reference.startsWith('/') && SAFE_PARTIAL_PATH_PATTERN.test(reference);
}

/**
 * Builds the ordered, most-specific-first list of candidate logical paths for
 * one role file of one registry key, per the documented override chain.
 */
export function buildOverrideCandidates(
  key: string,
  file: string,
  context: PromptResolutionContext,
): readonly { readonly logicalPath: string; readonly tier: PromptResolutionTier }[] {
  const { tenantId, locale } = context;
  const candidates: { logicalPath: string; tier: PromptResolutionTier }[] = [];

  if (tenantId !== undefined && locale !== undefined) {
    candidates.push({
      logicalPath: `overrides/${tenantId}/${locale}/${key}/${file}`,
      tier: 'tenant-locale',
    });
  }

  if (tenantId !== undefined) {
    candidates.push({ logicalPath: `overrides/${tenantId}/${key}/${file}`, tier: 'tenant' });
  }

  if (locale !== undefined) {
    candidates.push({ logicalPath: `overrides/${locale}/${key}/${file}`, tier: 'locale' });
  }

  candidates.push({ logicalPath: `${key}/${file}`, tier: 'base' });

  return candidates;
}

async function resolveRoleFile(
  key: string,
  role: PromptFileRole,
  context: PromptResolutionContext,
  source: PromptFileSource,
): Promise<{ readonly logicalPath: string; readonly tier: PromptResolutionTier } | undefined> {
  const candidates = buildOverrideCandidates(key, `${role}.md`, context);

  for (const candidate of candidates) {
    if (await source.fileExists(candidate.logicalPath)) {
      return candidate;
    }
  }

  return undefined;
}

async function expandPartials(
  content: string,
  chain: readonly string[],
  loadRaw: (logicalPath: string) => Promise<string>,
  fragments: IncludedFragment[],
): Promise<string> {
  const currentFile = chain[chain.length - 1] ?? '(unknown)';
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(PARTIAL_REFERENCE_PATTERN);

  while ((match = pattern.exec(content)) !== null) {
    const reference = match[1] ?? '';
    result += content.slice(lastIndex, match.index);

    if (!isSafePartialReference(reference)) {
      throw new PartialResolutionFailure({
        kind: 'missing-partial',
        message: `"${currentFile}" references "${reference}", which is not a valid shared-partial path.`,
      });
    }

    if (chain.includes(reference)) {
      throw new PartialResolutionFailure({
        kind: 'circular-partial',
        message: `Circular partial reference detected: ${[...chain, reference].join(' -> ')}`,
      });
    }

    let rawFragment: string;

    try {
      rawFragment = await loadRaw(reference);
    } catch {
      throw new PartialResolutionFailure({
        kind: 'missing-partial',
        message: `"${currentFile}" references shared partial "${reference}", which does not exist.`,
      });
    }

    fragments.push({ logicalPath: reference, includedFrom: currentFile });
    const expandedFragment = await expandPartials(
      rawFragment,
      [...chain, reference],
      loadRaw,
      fragments,
    );
    result += expandedFragment;
    lastIndex = match.index + match[0].length;
  }

  result += content.slice(lastIndex);
  return result;
}

function findVariableReferences(content: string): string[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(VARIABLE_REFERENCE_PATTERN);

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1] ?? '';
    if (!RESERVED_VARIABLE_NAMES.includes(name)) {
      names.add(name);
    }
  }

  return [...names];
}

function interpolate(content: string, vars: Readonly<Record<string, string>>): string {
  return content.replace(VARIABLE_REFERENCE_PATTERN, (fullMatch, name: string) => {
    if (RESERVED_VARIABLE_NAMES.includes(name)) {
      return fullMatch;
    }

    return name in vars ? (vars[name] ?? '') : fullMatch;
  });
}

function countPlaceholderOccurrences(content: string, placeholderName: string): number {
  const pattern = new RegExp(`\\{\\{\\s*${placeholderName}\\s*\\}\\}`, 'g');
  return [...content.matchAll(pattern)].length;
}

function injectRolePlaceholder(
  userContent: string,
  placeholderName: string,
  roleContent: string | undefined,
): string {
  if (roleContent === undefined) {
    return userContent;
  }

  const pattern = new RegExp(`\\{\\{\\s*${placeholderName}\\s*\\}\\}`, 'g');
  return userContent.replace(pattern, roleContent);
}

interface ResolvedRoleContent {
  readonly role: PromptFileRole;
  readonly source: PromptSourceInfo;
  readonly expandedContent: string;
}

/**
 * Resolves, expands, and interpolates every prompt file for one registry key,
 * then composes the optional roles into `user.md`'s special placeholders.
 *
 * Never throws for content-validation problems — every defect is returned as
 * a {@link PromptValidationIssue}, so this same function backs both the
 * fail-closed `PromptRegistry.get()` and the fail-open diagnostics API.
 */
export async function resolvePromptSet(
  key: string,
  vars: Readonly<Record<string, string>>,
  context: PromptResolutionContext,
  source: PromptFileSource,
  loadRaw: (logicalPath: string) => Promise<string>,
): Promise<PromptResolution> {
  const issues: PromptValidationIssue[] = [];
  const sources: PromptSourceInfo[] = [];
  const fragments: IncludedFragment[] = [];
  const resolvedRoles = new Map<PromptFileRole, ResolvedRoleContent>();

  for (const role of [...REQUIRED_PROMPT_ROLES, ...OPTIONAL_PROMPT_ROLES]) {
    const candidate = await resolveRoleFile(key, role, context, source);

    if (candidate === undefined) {
      if (REQUIRED_PROMPT_ROLES.includes(role)) {
        issues.push({
          kind: 'missing-file',
          message: `Registry key "${key}" is missing its required "${role}.md" file.`,
        });
      }
      continue;
    }

    const roleSource: PromptSourceInfo = {
      role,
      logicalPath: candidate.logicalPath,
      tier: candidate.tier,
    };
    sources.push(roleSource);

    let rawContent: string;

    try {
      rawContent = await loadRaw(candidate.logicalPath);
    } catch {
      issues.push({
        kind: 'missing-file',
        message: `Registry key "${key}"'s "${role}.md" resolved to "${candidate.logicalPath}", but that file could not be read.`,
      });
      continue;
    }

    try {
      const expandedContent = await expandPartials(
        rawContent,
        [candidate.logicalPath],
        loadRaw,
        fragments,
      );
      resolvedRoles.set(role, { role, source: roleSource, expandedContent });
    } catch (error) {
      if (error instanceof PartialResolutionFailure) {
        issues.push(error.issue);
        continue;
      }
      throw error;
    }
  }

  for (const [placeholderRole, placeholderName] of Object.entries(ROLE_PLACEHOLDER) as [
    'examples' | 'validation' | 'repair',
    string,
  ][]) {
    const userRole = resolvedRoles.get('user');
    if (userRole === undefined) {
      continue;
    }

    const placeholderCount = countPlaceholderOccurrences(userRole.expandedContent, placeholderName);
    const roleContent = resolvedRoles.get(placeholderRole);

    if (placeholderCount > 1) {
      issues.push({
        kind: 'duplicate-placeholder',
        message: `"${key}/user.md" contains "{{${placeholderName}}}" more than once (found ${String(placeholderCount)} times).`,
      });
    }

    if (placeholderCount > 0 && roleContent === undefined) {
      issues.push({
        kind: 'role-placeholder-mismatch',
        message: `"${key}/user.md" references "{{${placeholderName}}}", but "${key}/${placeholderRole}.md" does not exist.`,
      });
    }

    if (placeholderCount === 0 && roleContent !== undefined) {
      issues.push({
        kind: 'role-placeholder-mismatch',
        message: `"${key}/${placeholderRole}.md" exists, but "${key}/user.md" never references "{{${placeholderName}}}".`,
      });
    }
  }

  // Reserved role-composition placeholders (`{{examples}}`, `{{rubric}}`,
  // `{{repairInstructions}}`) are only ever valid inside user.md, where the
  // composition step above consumes them. `interpolate()` deliberately
  // leaves any reserved name untouched everywhere, specifically so user.md's
  // placeholders survive interpolation until composition runs — but that
  // same leniency means a reserved placeholder mistakenly left in any other
  // role's content would otherwise reach the assembled prompt verbatim,
  // unresolved, with no other check catching it. Treat that as a hard error.
  for (const [role, resolved] of resolvedRoles) {
    if (role === 'user') {
      continue;
    }

    for (const placeholderName of RESERVED_VARIABLE_NAMES) {
      if (countPlaceholderOccurrences(resolved.expandedContent, placeholderName) > 0) {
        issues.push({
          kind: 'misplaced-role-placeholder',
          message: `"${resolved.source.logicalPath}" contains the reserved placeholder "{{${placeholderName}}}", which is only valid inside "${key}/user.md".`,
        });
      }
    }
  }

  const referencedVariables = new Set<string>();
  for (const resolved of resolvedRoles.values()) {
    for (const name of findVariableReferences(resolved.expandedContent)) {
      referencedVariables.add(name);
    }
  }

  const suppliedVariables = Object.keys(vars);

  for (const suppliedName of suppliedVariables) {
    if (RESERVED_VARIABLE_NAMES.includes(suppliedName)) {
      issues.push({
        kind: 'reserved-variable-name',
        message: `"${suppliedName}" is a reserved placeholder name (used for role composition) and cannot be supplied as a variable.`,
      });
    }
  }

  const missingVariables = [...referencedVariables]
    .filter((name) => !(name in vars))
    .sort((a, b) => a.localeCompare(b));

  for (const missingName of missingVariables) {
    issues.push({
      kind: 'unresolved-variable',
      message: `Registry key "${key}" references variable "{{${missingName}}}", but no value was supplied.`,
    });
  }

  const unusedVariables = suppliedVariables
    .filter((name) => !RESERVED_VARIABLE_NAMES.includes(name) && !referencedVariables.has(name))
    .sort((a, b) => a.localeCompare(b));

  for (const unusedName of unusedVariables) {
    issues.push({
      kind: 'unused-variable',
      message: `Variable "${unusedName}" was supplied but is not referenced by any prompt file for registry key "${key}".`,
    });
  }

  const interpolated = new Map<PromptFileRole, string>();
  for (const [role, resolved] of resolvedRoles) {
    interpolated.set(role, interpolate(resolved.expandedContent, vars));
  }

  let composedUser = interpolated.get('user');
  if (composedUser !== undefined) {
    for (const [placeholderRole, placeholderName] of Object.entries(ROLE_PLACEHOLDER) as [
      'examples' | 'validation' | 'repair',
      string,
    ][]) {
      composedUser = injectRolePlaceholder(
        composedUser,
        placeholderName,
        interpolated.get(placeholderRole),
      );
    }
  }

  return {
    system: interpolated.get('system'),
    user: composedUser,
    examples: interpolated.get('examples'),
    validation: interpolated.get('validation'),
    repair: interpolated.get('repair'),
    sources,
    includedFragments: fragments,
    referencedVariables: [...referencedVariables].sort((a, b) => a.localeCompare(b)),
    suppliedVariables,
    missingVariables,
    unusedVariables,
    issues,
    valid: issues.length === 0,
  };
}

/**
 * A local, model-independent, approximate token count. This is a rough
 * proxy for prompt sizing during development, never an authoritative
 * provider token count.
 */
export function estimateApproximateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}
