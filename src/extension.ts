import * as vscode from 'vscode';
import {
    CcusageService,
    ProviderMode,
    UsageSummary,
    ClaudeUsageData,
    CodexUsageData,
    ProviderError,
    CodexRateLimitWindow,
    CodexRateLimits,
} from './ccusage-service';

let statusBarItem: vscode.StatusBarItem;
let ccusageService: CcusageService;
let updateTimer: NodeJS.Timeout | undefined;

type CodexDisplayMode = 'auto' | '5h' | 'weekly' | '1 week';
type CodexPercentageMode = 'remaining' | 'used';

export function activate(context: vscode.ExtensionContext) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    ccusageService = new CcusageService();

    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    startUpdateTimer();
    updateUsageDisplay();

    const configurationWatcher = vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('ccusage')) {
            return;
        }

        if (event.affectsConfiguration('ccusage.updateInterval')) {
            startUpdateTimer();
        }

        updateUsageDisplay();
    });

    context.subscriptions.push(configurationWatcher);
}

export function deactivate() {
    if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = undefined;
    }

    ccusageService?.dispose();
    statusBarItem?.dispose();
}

function startUpdateTimer() {
    if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = undefined;
    }

    const config = vscode.workspace.getConfiguration('ccusage');
    const interval = config.get<number>('updateInterval', 30) * 1000;

    updateTimer = setInterval(() => {
        updateUsageDisplay();
    }, interval);
}

async function updateUsageDisplay() {
    const config = vscode.workspace.getConfiguration('ccusage');
    const showCost = config.get<boolean>('showCost', true);
    const providerMode = config.get<ProviderMode>('providerMode', 'auto');
    const codexDisplayMode = config.get<CodexDisplayMode>('codexDisplayWindow', 'auto');
    const codexPercentageMode = config.get<CodexPercentageMode>('codexPercentageMode', 'remaining');

    try {
        const usageSummary = await ccusageService.getUsage(providerMode);
        applyUsageSummary(statusBarItem, usageSummary, providerMode, showCost, codexDisplayMode, codexPercentageMode);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        statusBarItem.text = '⚠️ CCUsage Error';
        statusBarItem.tooltip = `Error loading usage data: ${message}`;
        console.error('CCUsage extension error:', error);
    }
}

function applyUsageSummary(
    item: vscode.StatusBarItem,
    summary: UsageSummary,
    mode: ProviderMode,
    showCost: boolean,
    codexDisplayMode: CodexDisplayMode,
    codexPercentageMode: CodexPercentageMode,
): void {
    const segments: string[] = [];
    const tooltipSections: string[] = [];

    const claudeSegment = buildClaudeSegment(summary.claude, mode, showCost);
    if (claudeSegment != null) {
        segments.push(claudeSegment.text);
        tooltipSections.push(claudeSegment.tooltip);
    }

    const codexSegment = buildCodexSegment(summary.codex, mode, showCost, codexDisplayMode, codexPercentageMode);
    if (codexSegment != null) {
        segments.push(codexSegment.text);
        tooltipSections.push(codexSegment.tooltip);
    }

    if (segments.length === 0) {
        tooltipSections.push('Usage data is unavailable for the selected provider.');
        if (summary.errors.length > 0) {
            tooltipSections.push(formatErrors(summary.errors));
        }
        item.text = '⏱️ --';
        item.tooltip = tooltipSections.join('\n\n');
        return;
    }

    if (summary.errors.length > 0) {
        tooltipSections.push(formatErrors(summary.errors));
    }

    item.text = segments.join('   ');
    item.tooltip = tooltipSections.join('\n\n');
}

type StatusSegment = {
    text: string;
    tooltip: string;
};

function buildClaudeSegment(
    data: ClaudeUsageData | undefined,
    mode: ProviderMode,
    showCost: boolean,
): StatusSegment | null {
    if (mode === 'claude' && data == null) {
        return {
            text: 'Claude ⏱️ --',
            tooltip: 'Claude usage data is not available.',
        };
    }

    if (data == null) {
        return null;
    }

    if (!data.available && mode !== 'claude') {
        return null;
    }

    if (!data.available) {
        return {
            text: 'Claude ⏱️ --',
            tooltip: 'Claude data directory was not found. Configure Claude Code to enable usage tracking.',
        };
    }

    const displayCost = showCost ? ` | 💰 ${formatCurrency(data.costUSD)}` : '';
    const text = `Claude ⏱️ ${data.remainingTime}${displayCost}`;

    const tooltipLines = [
        'Claude Code 5-hour window',
        `Remaining: ${data.remainingTime}`,
        `Active blocks: ${data.blockCount}`,
        `Tokens (current window): ${formatTokens(data.totalTokens)}`,
    ];

    if (showCost) {
        tooltipLines.splice(2, 0, `Cost (current window): ${formatCurrency(data.costUSD)}`);
    }

    if (!data.hasData) {
        tooltipLines.push('No recent Claude activity detected.');
    }

    if (data.activeBlockEnd != null) {
        tooltipLines.push(`Block ends at: ${data.activeBlockEnd.toLocaleString()}`);
    }

    return {
        text,
        tooltip: tooltipLines.join('\n'),
    };
}

function buildCodexSegment(
    data: CodexUsageData | undefined,
    mode: ProviderMode,
    showCost: boolean,
    displayMode: CodexDisplayMode,
    percentageMode: CodexPercentageMode,
): StatusSegment | null {
    if (mode === 'codex' && data == null) {
        return {
            text: 'Codex ⏳ --',
            tooltip: 'Codex usage data is not available.',
        };
    }

    if (data == null) {
        return null;
    }

    if (!data.available && mode !== 'codex') {
        return null;
    }

    if (!data.available) {
        return {
            text: 'Codex ⏳ --',
            tooltip: `Codex session directory not found (checked: ${data.missingDirectories.join(', ') || 'n/a'}).`,
        };
    }

    const selectedWindow = selectCodexWindow(data.rateLimits, displayMode);
    const rawPercent = percentageMode === 'remaining'
        ? selectedWindow?.remainingPercent ?? (selectedWindow?.usedPercent != null
            ? 100 - selectedWindow.usedPercent
            : undefined)
        : selectedWindow?.usedPercent ?? (selectedWindow?.remainingPercent != null
            ? 100 - selectedWindow.remainingPercent
            : undefined);
    const percentValue = rawPercent != null ? Math.min(100, Math.max(0, rawPercent)) : undefined;
    const percentSuffix = percentageMode === 'remaining' ? '% left' : '% used';
    const percentText = percentValue != null
        ? `${formatPercent(percentValue)}${percentSuffix}`
        : percentageMode === 'remaining'
            ? '-- left'
            : '-- used';
    const resetText = selectedWindow?.resetsInSeconds != null
        ? formatDurationFromSeconds(selectedWindow.resetsInSeconds)
        : '--';
    const label = selectedWindow?.label ?? '--';
    const text = `Codex ⏳ ${label} ${percentText} · ${resetText}`;

    const tooltipLines: string[] = [];
    tooltipLines.push(`Codex rate limits (${data.timezone})`);
    tooltipLines.push(...buildRateLimitTooltipLines(data.rateLimits, selectedWindow?.id, percentageMode));

    tooltipLines.push('', `Date: ${data.displayDate}`);
    tooltipLines.push(`Tokens: ${formatTokens(data.totalTokens)}`);

    if (showCost) {
        tooltipLines.push(`Cost: ${data.costUSD != null ? formatCurrency(data.costUSD) : 'Unavailable'}`);
    }

    if (!data.hasData) {
        tooltipLines.push('No Codex activity recorded for this day.');
    }

    if (data.models.length > 0) {
        tooltipLines.push('', 'Models:');
        for (const model of data.models) {
            const costText = model.costUSD != null ? formatCurrency(model.costUSD) : 'N/A';
            tooltipLines.push(` • ${model.model}: ${formatTokens(model.usage.totalTokens)} tokens, cost ${costText}`);
        }
    }

    if (data.issues.length > 0) {
        tooltipLines.push('', 'Warnings:');
        for (const issue of data.issues) {
            tooltipLines.push(` • ${issue}`);
        }
    }

    if (data.missingDirectories.length > 0) {
        tooltipLines.push('', 'Missing directories:');
        for (const dir of data.missingDirectories) {
            tooltipLines.push(` • ${dir}`);
        }
    }

    return {
        text,
        tooltip: tooltipLines.join('\n'),
    };
}

function formatErrors(errors: ProviderError[]): string {
    const lines = ['Errors:'];
    for (const entry of errors) {
        lines.push(` • ${entry.provider}: ${entry.error.message}`);
    }
    return lines.join('\n');
}

function selectCodexWindow(rateLimits: CodexRateLimits, mode: CodexDisplayMode): CodexRateLimitWindow | undefined {
    const { primary, secondary } = rateLimits;

    if (mode === '5h') {
        return primary ?? secondary ?? undefined;
    }

    if (mode === 'weekly' || mode === '1 week') {
        return secondary ?? primary ?? undefined;
    }

    const candidates = [primary, secondary].filter((window): window is CodexRateLimitWindow => window != null);
    if (candidates.length === 0) {
        return undefined;
    }

    const score = (window: CodexRateLimitWindow): number => {
        if (window.remainingPercent != null) {
            return window.remainingPercent;
        }
        if (window.usedPercent != null) {
            return Math.max(0, Math.min(100, 100 - window.usedPercent));
        }
        return 101;
    };

    return candidates.sort((a, b) => score(a) - score(b))[0];
}

function buildRateLimitTooltipLines(
    rateLimits: CodexRateLimits,
    highlightId: string | undefined,
    percentageMode: CodexPercentageMode,
): string[] {
    const entries: Array<{ id: 'primary' | 'secondary'; title: string; window?: CodexRateLimitWindow }> = [
        { id: 'primary', title: '5-hour window', window: rateLimits.primary },
        { id: 'secondary', title: 'Weekly window', window: rateLimits.secondary },
    ];

    const lines: string[] = [];
    for (const entry of entries) {
        const bullet = highlightId === entry.id ? '•' : '◦';
        const window = entry.window;
        if (window) {
            const usedValue = window.usedPercent != null
                ? Math.max(0, Math.min(100, window.usedPercent))
                : undefined;
            const remainingValue = window.remainingPercent ?? (window.usedPercent != null ? 100 - window.usedPercent : undefined);
            const clampedRemaining = remainingValue != null ? Math.max(0, Math.min(100, remainingValue)) : undefined;
            const used = usedValue != null ? formatPercent(usedValue) : 'N/A';
            const remaining = clampedRemaining != null ? formatPercent(clampedRemaining) : 'N/A';
            const resetText = window.resetsInSeconds != null ? formatDurationFromSeconds(window.resetsInSeconds) : '--';
            const percentSummary = percentageMode === 'used'
                ? `used ${used}% (remaining ${remaining}%)`
                : `remaining ${remaining}% (used ${used}%)`;
            lines.push(`${bullet} ${entry.title}: ${percentSummary}, resets in ${resetText}`);
        }
        else {
            lines.push(`${bullet} ${entry.title}: data unavailable`);
        }
    }

    if (lines.length === 0) {
        lines.push('No rate limit data available.');
    }

    return lines;
}

function formatPercent(value: number): string {
    const hasFraction = !Number.isInteger(value);
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: hasFraction ? 1 : 0,
        maximumFractionDigits: 1,
    }).format(value);
}

function formatDurationFromSeconds(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        return '0m';
    }

    const seconds = Math.floor(totalSeconds % 60);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const totalHours = Math.floor(totalMinutes / 60);
    const hours = totalHours % 24;
    const days = Math.floor(totalHours / 24);

    const parts: string[] = [];
    if (days > 0) {
        parts.push(`${days}d`);
    }
    if (hours > 0 || days > 0) {
        parts.push(`${hours}h`);
    }
    if ((minutes > 0 && parts.length < 2) || parts.length === 0) {
        parts.push(`${minutes}m`);
    }
    if (parts.length === 1 && parts[0] === '0m' && seconds > 0) {
        return `${seconds}s`;
    }
    return parts.join(' ');
}

function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function formatTokens(value: number): string {
    return new Intl.NumberFormat('en-US').format(Math.round(value));
}
