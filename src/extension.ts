import * as vscode from 'vscode';
import { CcusageService } from './ccusage-service';

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
}

export function deactivate() {
    if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = undefined;
    }
    
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}

function startUpdateTimer() {
    const config = vscode.workspace.getConfiguration('ccusage');
    const interval = config.get<number>('updateInterval', 30) * 1000;
    
    updateTimer = setInterval(() => {
        updateUsageDisplay();
    }, interval);
}

async function updateUsageDisplay() {
    try {
        const usageData = await ccusageService.getCurrentUsage();
        const config = vscode.workspace.getConfiguration('ccusage');
        const showCost = config.get<boolean>('showCost', true);
        
        let text = `⏱️ ${usageData.remainingTime}`;
        if (showCost) {
            text += ` | 💰 $${usageData.cost.toFixed(2)}`;
        }
        
        statusBarItem.text = text;
        statusBarItem.tooltip = `Current 5-hour block usage\nRemaining: ${usageData.remainingTime}\nCost: $${usageData.cost.toFixed(2)}\nTokens: ${usageData.totalTokens.toLocaleString()}`;
    } catch (error) {
        statusBarItem.text = '⚠️ CCUsage Error';
        statusBarItem.tooltip = `Error loading usage data: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error('CCUsage extension error:', error);
    }
}