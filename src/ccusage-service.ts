import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_SESSION_DURATION_MS = 5 * 60 * 60 * 1000;
const MILLION = 1_000_000;
const CLAUDE_PROJECTS_DIR = 'projects';
const CLAUDE_JSONL_LIMIT = 200; // avoid scanning the entire history when unnecessary
const CODEX_DEFAULT_SESSION_SUBDIR = 'sessions';
const CODEX_ENV_HOME = 'CODEX_HOME';
const CLAUDE_ENV_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

/**
 * 一部の集計ロジックは MIT ライセンスの {@link https://github.com/ryoppippi/ccusage }
 * `apps/ccusage/src/data-loader.ts` と `apps/codex/src/data-loader.ts` を参考に再実装しています。
 */

export type Provider = 'claude' | 'codex';
export type ProviderMode = 'claude' | 'codex' | 'both' | 'auto';

export interface UsageQueryOptions {
    timezone?: string;
    locale?: string;
}

export interface ProviderError {
    provider: Provider;
    error: Error;
}

export interface ClaudeUsageData {
    provider: 'claude';
    available: boolean;
    hasData: boolean;
    remainingTime: string;
    costUSD: number;
    totalTokens: number;
    activeBlockEnd?: Date;
    blockCount: number;
}

export interface CodexModelUsageSummary {
    model: string;
    usage: TokenUsageDelta;
    costUSD?: number;
    isFallbackModel: boolean;
}

export interface CodexUsageData {
    provider: 'codex';
    available: boolean;
    hasData: boolean;
    dateKey: string;
    displayDate: string;
    totalTokens: number;
    costUSD?: number;
    models: CodexModelUsageSummary[];
    timezone: string;
    missingDirectories: string[];
    issues: string[];
}

export type UsageData = ClaudeUsageData | CodexUsageData;

export interface UsageSummary {
    claude?: ClaudeUsageData;
    codex?: CodexUsageData;
    errors: ProviderError[];
}

type ClaudeUsageEntry = {
    timestamp: Date;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostUSD?: number;
};

type RawCodexUsage = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
};

type TokenUsageEvent = {
    timestamp: Date;
    model?: string;
    usage: RawCodexUsage;
    isFallbackModel: boolean;
};

export type TokenUsageDelta = RawCodexUsage;

type ModelPricing = {
    inputCostPerMToken: number;
    cachedInputCostPerMToken: number;
    outputCostPerMToken: number;
};

const CODEX_MODEL_PRICING: Record<string, ModelPricing> = {
    'gpt-5': { inputCostPerMToken: 1.25, cachedInputCostPerMToken: 0.125, outputCostPerMToken: 10 },
    'gpt-5-mini': { inputCostPerMToken: 0.6, cachedInputCostPerMToken: 0.06, outputCostPerMToken: 2 },
    'gpt-4.1': { inputCostPerMToken: 5, cachedInputCostPerMToken: 0.5, outputCostPerMToken: 15 },
    'gpt-4.1-mini': { inputCostPerMToken: 1, cachedInputCostPerMToken: 0.1, outputCostPerMToken: 4 },
};

const CODEX_MODEL_ALIASES = new Map<string, string>([
    ['gpt-5-codex', 'gpt-5'],
    ['gpt-5o', 'gpt-5'],
    ['gpt-5-mini-codex', 'gpt-5-mini'],
    ['gpt-4.1-preview', 'gpt-4.1'],
]);

export class CcusageService {
    async getUsage(mode: ProviderMode, options: UsageQueryOptions = {}): Promise<UsageSummary> {
        const summary: UsageSummary = { errors: [] };
        const shouldLoadClaude = mode === 'claude' || mode === 'both' || mode === 'auto';
        const shouldLoadCodex = mode === 'codex' || mode === 'both' || mode === 'auto';

        const loaders: Promise<void>[] = [];

        if (shouldLoadClaude) {
            loaders.push(
                this.loadClaudeUsage().then(data => {
                    summary.claude = data;
                }).catch(error => {
                    summary.errors.push({ provider: 'claude', error: asError(error) });
                }),
            );
        }

        if (shouldLoadCodex) {
            loaders.push(
                this.loadCodexUsage(options).then(data => {
                    summary.codex = data;
                }).catch(error => {
                    summary.errors.push({ provider: 'codex', error: asError(error) });
                }),
            );
        }

        await Promise.all(loaders);

        if (mode === 'claude' && summary.claude == null) {
            throw this.composeError(summary.errors, 'Claude usage data is unavailable.');
        }

        if (mode === 'codex' && summary.codex == null) {
            throw this.composeError(summary.errors, 'Codex usage data is unavailable.');
        }

        if (!shouldLoadClaude && !shouldLoadCodex) {
            throw new Error('No provider selected for usage retrieval.');
        }

        if (summary.claude == null && summary.codex == null && summary.errors.length > 0) {
            throw this.composeError(summary.errors, 'Failed to load usage data.');
        }

        return summary;
    }

    dispose(): void {
        // no resources to release
    }

    private async loadClaudeUsage(): Promise<ClaudeUsageData> {
        const now = new Date();
        const windowStart = new Date(now.getTime() - CLAUDE_SESSION_DURATION_MS);

        const claudeDirs = await resolveClaudeDataDirectories();
        const projectDirs: string[] = [];
        for (const dir of claudeDirs) {
            const projects = path.join(dir, CLAUDE_PROJECTS_DIR);
            if (await pathExists(projects)) {
                projectDirs.push(projects);
            }
        }

        const transcripts = await collectJsonlFiles(projectDirs, CLAUDE_JSONL_LIMIT);
        const entries: ClaudeUsageEntry[] = [];

        for (const file of transcripts) {
            const fileEntries = await parseClaudeTranscript(file, windowStart);
            entries.push(...fileEntries);
        }

        if (entries.length === 0) {
            return {
                provider: 'claude',
                available: claudeDirs.length > 0,
                hasData: false,
                remainingTime: formatRemainingTime(CLAUDE_SESSION_DURATION_MS),
                costUSD: 0,
                totalTokens: 0,
                blockCount: 0,
            };
        }

        entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const totalTokens = entries.reduce((sum, entry) => (
            sum + entry.inputTokens + entry.outputTokens + entry.cacheCreationInputTokens + entry.cacheReadInputTokens
        ), 0);

        const totalCost = entries.reduce((sum, entry) => sum + (entry.totalCostUSD ?? 0), 0);
        const latestTimestamp = entries[entries.length - 1]!.timestamp;
        const remainingMs = Math.max(0, (latestTimestamp.getTime() + CLAUDE_SESSION_DURATION_MS) - now.getTime());

        return {
            provider: 'claude',
            available: claudeDirs.length > 0,
            hasData: true,
            remainingTime: formatRemainingTime(remainingMs),
            costUSD: totalCost,
            totalTokens,
            activeBlockEnd: new Date(latestTimestamp.getTime() + CLAUDE_SESSION_DURATION_MS),
            blockCount: 1,
        };
    }

    private async loadCodexUsage(options: UsageQueryOptions): Promise<CodexUsageData> {
        const timezone = resolveTimeZone(options.timezone);
        const locale = resolveLocale(options.locale);
        const sessionDirs = await resolveCodexSessionDirectories();

        const events: TokenUsageEvent[] = [];
        const missingDirectories: string[] = [];
        const issues: string[] = [];

        for (const dir of sessionDirs) {
            if (!(await pathExists(dir))) {
                missingDirectories.push(dir);
                continue;
            }

            const files = await collectJsonlFiles([dir]);
            for (const file of files) {
                const result = await parseCodexSession(file);
                events.push(...result.events);
                if (result.issues.length > 0) {
                    issues.push(...result.issues.map(issue => `${path.basename(file)}: ${issue}`));
                }
            }
        }

        if (events.length === 0) {
            const todayKeyEmpty = toDateKey(new Date(), timezone);
            return {
                provider: 'codex',
                available: sessionDirs.length > 0 && missingDirectories.length !== sessionDirs.length,
                hasData: false,
                dateKey: todayKeyEmpty,
                displayDate: formatDisplayDate(todayKeyEmpty, locale, timezone),
                totalTokens: 0,
                costUSD: undefined,
                models: [],
                timezone,
                missingDirectories,
                issues,
            };
        }

        events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const todayKey = toDateKey(new Date(), timezone);
        const todaysEvents = events.filter(event => toDateKey(event.timestamp, timezone) === todayKey);

        if (todaysEvents.length === 0) {
            return {
                provider: 'codex',
                available: sessionDirs.length > 0,
                hasData: false,
                dateKey: todayKey,
                displayDate: formatDisplayDate(todayKey, locale, timezone),
                totalTokens: 0,
                costUSD: undefined,
                models: [],
                timezone,
                missingDirectories,
                issues,
            };
        }

        const aggregate: RawCodexUsage = {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
        };

        const perModel = new Map<string, { usage: RawCodexUsage; isFallback: boolean }>();

        for (const event of todaysEvents) {
            addUsage(aggregate, event.usage);
            if (!event.model) {
                continue;
            }
            const existing = perModel.get(event.model) ?? {
                usage: createEmptyUsage(),
                isFallback: false,
            };
            addUsage(existing.usage, event.usage);
            existing.isFallback = existing.isFallback || event.isFallbackModel;
            perModel.set(event.model, existing);
        }

        const modelSummaries: CodexModelUsageSummary[] = [];
        let totalCost = 0;
        for (const [model, data] of perModel.entries()) {
            const pricing = lookupCodexPricing(model);
            let cost: number | undefined;
            if (pricing) {
                cost = calculateCostUSD(data.usage, pricing);
                totalCost += cost;
            }
            else {
                issues.push(`Pricing not found for model ${model}`);
            }

            modelSummaries.push({
                model,
                usage: { ...data.usage },
                costUSD: cost,
                isFallbackModel: data.isFallback,
            });
        }

        return {
            provider: 'codex',
            available: sessionDirs.length > 0 && missingDirectories.length !== sessionDirs.length,
            hasData: true,
            dateKey: todayKey,
            displayDate: formatDisplayDate(todayKey, locale, timezone),
            totalTokens: aggregate.totalTokens,
            costUSD: modelSummaries.every(model => model.costUSD !== undefined) && modelSummaries.length > 0
                ? totalCost
                : undefined,
            models: modelSummaries.sort((a, b) => b.usage.totalTokens - a.usage.totalTokens),
            timezone,
            missingDirectories,
            issues,
        };
    }

    private composeError(errors: ProviderError[], fallbackMessage: string): Error {
        if (errors.length === 0) {
            return new Error(fallbackMessage);
        }

        const detail = errors.map(err => `${err.provider}: ${err.error.message}`).join('; ');
        return new Error(`${fallbackMessage} (${detail})`);
    }
}

async function resolveClaudeDataDirectories(): Promise<string[]> {
    const directories: string[] = [];

    const envValue = process.env[CLAUDE_ENV_CONFIG_DIR]?.trim();
    if (envValue) {
        const envPaths = envValue.split(',').map(segment => segment.trim()).filter(Boolean);
        for (const dir of envPaths) {
            const resolved = path.resolve(dir);
            if (await pathExists(resolved)) {
                directories.push(resolved);
            }
        }
        if (directories.length > 0) {
            return directories;
        }
    }

    const home = os.homedir();
    const defaults = [path.join(home, '.config', 'claude'), path.join(home, '.claude')];
    for (const dir of defaults) {
        if (await pathExists(dir)) {
            directories.push(dir);
        }
    }

    return directories;
}

async function resolveCodexSessionDirectories(): Promise<string[]> {
    const directories: string[] = [];
    const envValue = process.env[CODEX_ENV_HOME]?.trim();
    if (envValue) {
        const envPath = path.resolve(envValue);
        directories.push(path.join(envPath, CODEX_DEFAULT_SESSION_SUBDIR));
    }
    const home = os.homedir();
    directories.push(path.join(home, '.codex', CODEX_DEFAULT_SESSION_SUBDIR));
    return Array.from(new Set(directories));
}

async function collectJsonlFiles(roots: string[], limit?: number): Promise<string[]> {
    const files: { path: string; mtimeMs: number }[] = [];
    for (const root of roots) {
        try {
            const stats = await fs.readdir(root, { withFileTypes: true });
            for (const entry of stats) {
                const entryPath = path.join(root, entry.name);
                if (entry.isDirectory()) {
                    const nested = await collectJsonlFiles([entryPath]);
                    for (const nestedPath of nested) {
                        const nestedStats = await safeStat(nestedPath);
                        if (nestedStats) {
                            files.push({ path: nestedPath, mtimeMs: nestedStats.mtimeMs });
                        }
                    }
                }
                else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    const stat = await safeStat(entryPath);
                    if (stat) {
                        files.push({ path: entryPath, mtimeMs: stat.mtimeMs });
                    }
                }
            }
        }
        catch (error) {
            // ignore directories we cannot read
            console.warn(`Failed to read directory ${root}:`, error);
        }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (limit && files.length > limit) {
        return files.slice(0, limit).map(item => item.path);
    }

    return files.map(item => item.path);
}

async function parseClaudeTranscript(filePath: string, windowStart: Date): Promise<ClaudeUsageEntry[]> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
        const entries: ClaudeUsageEntry[] = [];

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const usage = extractClaudeUsage(parsed);
                if (!usage) {
                    continue;
                }

                if (usage.timestamp < windowStart) {
                    continue;
                }

                entries.push(usage);
            }
            catch (error) {
                console.warn(`Failed to parse Claude usage line in ${filePath}:`, error);
            }
        }

        return entries;
    }
    catch (error) {
        console.warn(`Failed to read Claude transcript ${filePath}:`, error);
        return [];
    }
}

function extractClaudeUsage(record: Record<string, unknown>): ClaudeUsageEntry | null {
    const timestamp = parseTimestamp(record);
    if (!timestamp) {
        return null;
    }

    const message = record.message as Record<string, unknown> | undefined;
    const usageCandidate = (message?.usage ?? record.usage) as Record<string, unknown> | undefined;
    if (!usageCandidate) {
        return null;
    }

    const inputTokens = asPositiveNumber(usageCandidate.input_tokens);
    const outputTokens = asPositiveNumber(usageCandidate.output_tokens);
    const cacheCreationTokens = asPositiveNumber(usageCandidate.cache_creation_input_tokens);
    const cacheReadTokens = asPositiveNumber(usageCandidate.cache_read_input_tokens);
    const totalCostUSD = asPositiveNumber(usageCandidate.total_cost_usd ?? usageCandidate.cost_usd ?? usageCandidate.usd_cost);

    if (inputTokens === 0 && outputTokens === 0 && cacheCreationTokens === 0 && cacheReadTokens === 0 && totalCostUSD === 0) {
        return null;
    }

    return {
        timestamp,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreationTokens,
        cacheReadInputTokens: cacheReadTokens,
        totalCostUSD: totalCostUSD || undefined,
    };
}

async function parseCodexSession(filePath: string): Promise<{ events: TokenUsageEvent[]; issues: string[] }> {
    const events: TokenUsageEvent[] = [];
    const issues: string[] = [];

    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

        let previousTotals: RawCodexUsage | null = null;
        let currentModel: string | undefined;
        let currentModelIsFallback = false;
        let legacyFallbackUsed = false;

        for (const rawLine of lines) {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(rawLine) as Record<string, unknown>;
            }
            catch (error) {
                issues.push(`Invalid JSON line: ${String(error)}`);
                continue;
            }

            const entryType = typeof parsed.type === 'string' ? parsed.type : undefined;
            if (entryType === 'turn_context') {
                const payload = parsed.payload as Record<string, unknown> | undefined;
                const payloadModel = extractCodexModel(payload);
                if (payloadModel) {
                    currentModel = payloadModel;
                    currentModelIsFallback = false;
                }
                continue;
            }

            if (entryType !== 'event_msg') {
                continue;
            }

            const payload = parsed.payload as Record<string, unknown> | undefined;
            const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
            if (payloadType !== 'token_count') {
                continue;
            }

            const timestamp = parseTimestamp(parsed);
            if (!timestamp) {
                continue;
            }

            const info = payload?.info as Record<string, unknown> | undefined;
            const lastUsage = normalizeCodexUsage(info?.last_token_usage);
            const totalUsage = normalizeCodexUsage(info?.total_token_usage);

            let usage = lastUsage;
            if (!usage && totalUsage) {
                usage = subtractCodexUsage(totalUsage, previousTotals);
            }

            if (totalUsage) {
                previousTotals = totalUsage;
            }

            if (!usage || isUsageEmpty(usage)) {
                continue;
            }

            const extractionSource = Object.assign({}, payload, { info });
            const extractedModel = extractCodexModel(extractionSource);
            let isFallback = false;

            if (extractedModel) {
                currentModel = extractedModel;
                currentModelIsFallback = false;
            }

            let model = extractedModel ?? currentModel;
            if (!model) {
                model = 'gpt-5';
                isFallback = true;
                legacyFallbackUsed = true;
                currentModel = model;
                currentModelIsFallback = true;
            }
            else if (!extractedModel && currentModelIsFallback) {
                isFallback = true;
            }

            events.push({
                timestamp,
                model,
                usage,
                isFallbackModel: isFallback,
            });
        }

        if (legacyFallbackUsed) {
            issues.push('Legacy session lacked model metadata; applied fallback model gpt-5.');
        }
    }
    catch (error) {
        issues.push(`Failed to read session: ${String(error)}`);
    }

    return { events, issues };
}

function normalizeCodexUsage(value: unknown): RawCodexUsage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const record = value as Record<string, unknown>;
    const inputTokens = asPositiveNumber(record.input_tokens);
    const cachedTokens = asPositiveNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
    const outputTokens = asPositiveNumber(record.output_tokens);
    const reasoningTokens = asPositiveNumber(record.reasoning_output_tokens);
    const totalTokens = asPositiveNumber(record.total_tokens);

    const normalisedTotal = totalTokens > 0 ? totalTokens : inputTokens + outputTokens;

    return {
        inputTokens,
        cachedInputTokens: Math.min(cachedTokens, inputTokens),
        outputTokens,
        reasoningOutputTokens: reasoningTokens,
        totalTokens: normalisedTotal,
    };
}

function subtractCodexUsage(current: RawCodexUsage, previous: RawCodexUsage | null): RawCodexUsage {
    if (!previous) {
        return current;
    }

    return {
        inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
        cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
        outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
        reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
        totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
    };
}

function addUsage(target: RawCodexUsage, delta: RawCodexUsage): void {
    target.inputTokens += delta.inputTokens;
    target.cachedInputTokens += delta.cachedInputTokens;
    target.outputTokens += delta.outputTokens;
    target.reasoningOutputTokens += delta.reasoningOutputTokens;
    target.totalTokens += delta.totalTokens;
}

function createEmptyUsage(): RawCodexUsage {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
    };
}

function calculateCostUSD(usage: RawCodexUsage, pricing: ModelPricing): number {
    const inputCost = (usage.inputTokens - usage.cachedInputTokens) / MILLION * pricing.inputCostPerMToken;
    const cachedCost = usage.cachedInputTokens / MILLION * pricing.cachedInputCostPerMToken;
    const outputCost = usage.outputTokens / MILLION * pricing.outputCostPerMToken;
    return inputCost + cachedCost + outputCost;
}

function toDateKey(value: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return formatter.format(value);
}

function formatDisplayDate(dateKey: string, locale: string, timezone: string): string {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    const formatter = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
    });
    return formatter.format(date);
}

function formatRemainingTime(ms: number): string {
    const hours = Math.max(0, Math.floor(ms / (60 * 60 * 1000)));
    const minutes = Math.max(0, Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000)));
    return `${hours}h ${minutes}m`;
}

function resolveTimeZone(preferred?: string): string {
    if (preferred && preferred.trim().length > 0) {
        return preferred;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

function resolveLocale(preferred?: string): string {
    if (preferred && preferred.trim().length > 0) {
        return preferred;
    }
    return Intl.NumberFormat().resolvedOptions().locale ?? 'en-US';
}

function lookupCodexPricing(model: string): ModelPricing | undefined {
    const lower = model.toLowerCase();
    const aliasTarget = CODEX_MODEL_ALIASES.get(lower);
    if (aliasTarget && CODEX_MODEL_PRICING[aliasTarget]) {
        return CODEX_MODEL_PRICING[aliasTarget];
    }
    return CODEX_MODEL_PRICING[lower] ?? CODEX_MODEL_PRICING[model];
}

function parseTimestamp(record: Record<string, unknown>): Date | null {
    const candidates = [record.timestamp, record.time, record.created_at];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            const parsed = new Date(candidate);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed;
            }
        }
    }
    return null;
}

function extractCodexModel(source: Record<string, unknown> | undefined): string | undefined {
    if (!source) {
        return undefined;
    }

    const directCandidates = [source.model, source.model_name];
    for (const candidate of directCandidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }

    const info = source.info as Record<string, unknown> | undefined;
    if (info) {
        const infoCandidates = [info.model, info.model_name];
        for (const candidate of infoCandidates) {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                return candidate.trim();
            }
        }
        const metadata = info.metadata as Record<string, unknown> | undefined;
        if (metadata) {
            const metadataModel = metadata.model;
            if (typeof metadataModel === 'string' && metadataModel.trim().length > 0) {
                return metadataModel.trim();
            }
        }
    }

    const metadata = source.metadata as Record<string, unknown> | undefined;
    if (metadata) {
        const metadataModel = metadata.model;
        if (typeof metadataModel === 'string' && metadataModel.trim().length > 0) {
            return metadataModel.trim();
        }
    }

    return undefined;
}

function asPositiveNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return 0;
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    }
    catch {
        return false;
    }
}

async function safeStat(target: string): Promise<Stats | null> {
    try {
        return await fs.stat(target);
    }
    catch {
        return null;
    }
}

function isUsageEmpty(usage: RawCodexUsage): boolean {
    return usage.inputTokens === 0
        && usage.cachedInputTokens === 0
        && usage.outputTokens === 0
        && usage.reasoningOutputTokens === 0
        && usage.totalTokens === 0;
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown error');
}
