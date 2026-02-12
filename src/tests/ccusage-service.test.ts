import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CcusageService } from '../ccusage-service';

const CLAUDE_JSON = (timestamp: string) => JSON.stringify({
    timestamp,
    message: {
        usage: {
            input_tokens: 1200,
            output_tokens: 340,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
            total_cost_usd: 0.42,
        },
    },
});

const CODEX_TURN_CONTEXT = (timestamp: string) => JSON.stringify({
    type: 'turn_context',
    timestamp,
    payload: {
        model: 'gpt-5-mini',
    },
});

type CodexRateLimitFixture = {
    primary: {
        used_percent: number;
        window_minutes: number;
        resets_in_seconds?: number;
        resets_at?: number;
    };
    secondary: {
        used_percent: number;
        window_minutes: number;
        resets_in_seconds?: number;
        resets_at?: number;
    };
};

const DEFAULT_CODEX_RATE_LIMITS: CodexRateLimitFixture = {
    primary: {
        used_percent: 12.5,
        window_minutes: 299,
        resets_in_seconds: 1800,
    },
    secondary: {
        used_percent: 45.6,
        window_minutes: 10079,
        resets_in_seconds: 7200,
    },
};

const CODEX_TOKEN_EVENT = (timestamp: string, rateLimits: CodexRateLimitFixture = DEFAULT_CODEX_RATE_LIMITS) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
        type: 'token_count',
        model: 'gpt-5-mini',
        info: {
            last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 200,
                output_tokens: 1500,
                reasoning_output_tokens: 0,
                total_tokens: 2500,
            },
        },
        rate_limits: rateLimits,
    },
});

describe('CcusageService', () => {
    const originals = {
        claudeDir: process.env.CLAUDE_CONFIG_DIR,
        codexDir: process.env.CODEX_HOME,
    };

    let tempBase: string;
    let fakeHome: string;
    let homedirSpy: ReturnType<typeof vi.spyOn> | null = null;

    beforeEach(async () => {
        vi.useFakeTimers();
        const baseTime = new Date('2024-01-01T12:00:00Z');
        vi.setSystemTime(baseTime);

        tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'ccusage-test-'));
        fakeHome = path.join(tempBase, 'home');
        await fs.mkdir(fakeHome, { recursive: true });

        const claudeRoot = path.join(tempBase, 'claude-config');
        const codexHome = path.join(tempBase, 'codex-home');
        process.env.CLAUDE_CONFIG_DIR = claudeRoot;
        process.env.CODEX_HOME = codexHome;

        homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

        await fs.mkdir(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });
        await fs.mkdir(path.join(claudeRoot, 'projects', 'demo'), { recursive: true });
        await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });

        const now = new Date();
        const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

        const claudeFile = path.join(claudeRoot, 'projects', 'demo', 'session.jsonl');
        await fs.writeFile(claudeFile, `${CLAUDE_JSON(recent)}\n`);

        const codexFile = path.join(codexHome, 'sessions', 'session.jsonl');
        const codexLines = [
            CODEX_TURN_CONTEXT(recent),
            CODEX_TOKEN_EVENT(recent),
        ];
        await fs.writeFile(codexFile, `${codexLines.join('\n')}\n`);
    });

    afterEach(async () => {
        vi.useRealTimers();

        if (homedirSpy) {
            homedirSpy.mockRestore();
            homedirSpy = null;
        }

        if (originals.claudeDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originals.claudeDir;
        }

        if (originals.codexDir === undefined) {
            delete process.env.CODEX_HOME;
        }
        else {
            process.env.CODEX_HOME = originals.codexDir;
        }

        if (tempBase) {
            await fs.rm(tempBase, { recursive: true, force: true });
        }
    });

    it('aggregates Claude and Codex usage when data files are present', async () => {
        const service = new CcusageService();
        const summary = await service.getUsage('both', { locale: 'en-US', timezone: 'UTC' });

        expect(summary.errors).toEqual([]);

        const claude = summary.claude;
        expect(claude).toBeDefined();
        expect(claude?.available).toBe(true);
        expect(claude?.hasData).toBe(true);
        expect(claude?.totalTokens).toBe(1555);
        expect(claude?.costUSD).toBeCloseTo(0.42, 6);
        expect(claude?.remainingTime).toMatch(/^\d+h \d+m$/);
        expect(claude?.blockCount).toBe(1);
        expect(claude?.activeBlockEnd).toBeInstanceOf(Date);

        const codex = summary.codex;
        expect(codex).toBeDefined();
        expect(codex?.available).toBe(true);
        expect(codex?.hasData).toBe(true);
        expect(codex?.totalTokens).toBe(2500);
        expect(codex?.timezone).toBe('UTC');
        expect(codex?.missingDirectories).toEqual([]);
        expect(codex?.issues).toEqual([]);
        expect(codex?.models.length).toBe(1);
        expect(codex?.models[0]?.model).toBe('gpt-5-mini');
        expect(codex?.models[0]?.usage.totalTokens).toBe(2500);
        expect(codex?.models[0]?.isFallbackModel).toBe(false);

        const expectedCost = (800 / 1_000_000) * 0.6 + (200 / 1_000_000) * 0.06 + (1500 / 1_000_000) * 2;
        expect(codex?.costUSD).toBeCloseTo(expectedCost, 10);
        expect(codex?.models[0]?.costUSD).toBeCloseTo(expectedCost, 10);

        expect(codex?.rateLimits.primary).toBeDefined();
        expect(codex?.rateLimits.primary?.label).toBe('5h');
        expect(codex?.rateLimits.primary?.usedPercent).toBeCloseTo(12.5, 6);
        expect(codex?.rateLimits.primary?.remainingPercent).toBeCloseTo(87.5, 6);
        expect(codex?.rateLimits.primary?.resetsInSeconds).toBeCloseTo(1200, 6);

        expect(codex?.rateLimits.secondary).toBeDefined();
        expect(codex?.rateLimits.secondary?.label).toBe('1 week');
        expect(codex?.rateLimits.secondary?.usedPercent).toBeCloseTo(45.6, 6);
        expect(codex?.rateLimits.secondary?.remainingPercent).toBeCloseTo(54.4, 6);
        expect(codex?.rateLimits.secondary?.resetsInSeconds).toBeCloseTo(6600, 6);

        const today = new Date();
        const expectedDateKey = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(today);
        const expectedDisplayDate = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
        }).format(today);
        expect(codex?.dateKey).toBe(expectedDateKey);
        expect(codex?.displayDate).toBe(expectedDisplayDate);
    });

    it('supports resets_at values for 5h and 1 week windows', async () => {
        const codexHome = process.env.CODEX_HOME;
        if (!codexHome) {
            throw new Error('CODEX_HOME is not set in test setup');
        }

        const now = new Date();
        const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
        const primaryResetsAtSeconds = Math.floor((now.getTime() + 3600 * 1000) / 1000);
        const secondaryResetsAtMillis = now.getTime() + (2 * 24 * 60 * 60 * 1000);

        const codexFile = path.join(codexHome, 'sessions', 'session.jsonl');
        const codexLines = [
            CODEX_TURN_CONTEXT(recent),
            CODEX_TOKEN_EVENT(recent, {
                primary: {
                    used_percent: 20,
                    window_minutes: 300,
                    resets_at: primaryResetsAtSeconds,
                },
                secondary: {
                    used_percent: 30,
                    window_minutes: 10080,
                    resets_at: secondaryResetsAtMillis,
                },
            }),
        ];
        await fs.writeFile(codexFile, `${codexLines.join('\n')}\n`);

        const service = new CcusageService();
        const summary = await service.getUsage('codex', { locale: 'en-US', timezone: 'UTC' });
        const codex = summary.codex;

        expect(codex).toBeDefined();
        expect(codex?.rateLimits.primary?.label).toBe('5h');
        expect(codex?.rateLimits.primary?.resetsInSeconds).toBeCloseTo(3600, 6);

        expect(codex?.rateLimits.secondary?.label).toBe('1 week');
        expect(codex?.rateLimits.secondary?.resetsInSeconds).toBeCloseTo(172800, 6);
    });
});
