import * as vscode from 'vscode';
import {
    CcusageService,
    ProviderMode,
    UsageSummary,
    ClaudeUsageData,
    CodexUsageData,
    ProviderError,
} from './ccusage-service';

let statusBarItem: vscode.StatusBarItem;
let ccusageService: CcusageService;
let updateTimer: NodeJS.Timeout | undefined;

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

    try {
        const usageSummary = await ccusageService.getUsage(providerMode);
        applyUsageSummary(statusBarItem, usageSummary, providerMode, showCost);
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
): void {
    const segments: string[] = [];
    const tooltipSections: string[] = [];

    const claudeSegment = buildClaudeSegment(summary.claude, mode, showCost);
    if (claudeSegment != null) {
        segments.push(claudeSegment.text);
        tooltipSections.push(claudeSegment.tooltip);
    }

    const codexSegment = buildCodexSegment(summary.codex, mode, showCost);
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
): StatusSegment | null {
    if (mode === 'codex' && data == null) {
        return {
            text: 'Codex 📅 --',
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
            text: 'Codex 📅 --',
            tooltip: `Codex session directory not found (checked: ${data.missingDirectories.join(', ') || 'n/a'}).`,
        };
    }

    const costPart = showCost && data.costUSD != null
        ? ` | 💰 ${formatCurrency(data.costUSD)}`
        : ` | 🔢 ${formatTokens(data.totalTokens)}`;
    const text = `Codex 📅 ${data.displayDate}${costPart}`;

    const tooltipLines = [
        `Codex daily usage (${data.timezone})`,
        `Date: ${data.displayDate}`,
        `Tokens: ${formatTokens(data.totalTokens)}`,
    ];

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
