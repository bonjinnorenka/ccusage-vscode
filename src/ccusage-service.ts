export interface UsageData {
    remainingTime: string;
    cost: number;
    totalTokens: number;
}

export class CcusageService {
    private readonly FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
    
    async getCurrentUsage(): Promise<UsageData> {
        try {
            const { loadSessionBlockData, getDefaultClaudePath } = await import('ccusage/data-loader');
            
            const claudePath = getDefaultClaudePath();
            const currentTime = new Date();
            
            const sessionBlocks = await loadSessionBlockData({
                claudePath,
                sessionDurationHours: 5
            });
            
            if (!sessionBlocks || sessionBlocks.length === 0) {
                return {
                    remainingTime: '5h 0m',
                    cost: 0,
                    totalTokens: 0
                };
            }
            
            const currentBlocks = sessionBlocks.filter(block => 
                block.isActive || 
                (block.endTime.getTime() > currentTime.getTime())
            );
            
            if (currentBlocks.length === 0) {
                return {
                    remainingTime: '5h 0m',
                    cost: 0,
                    totalTokens: 0
                };
            }
            
            const latestBlock = currentBlocks[currentBlocks.length - 1];
            const remainingTimeMs = Math.max(0, latestBlock.endTime.getTime() - currentTime.getTime());
            const remainingTime = this.formatRemainingTime(remainingTimeMs);
            
            const totalCost = currentBlocks.reduce((sum, block) => sum + block.costUSD, 0);
            const totalTokens = currentBlocks.reduce((sum, block) => {
                const { tokenCounts } = block;
                return sum + tokenCounts.inputTokens + tokenCounts.outputTokens + 
                       tokenCounts.cacheCreationInputTokens + tokenCounts.cacheReadInputTokens;
            }, 0);
            
            return {
                remainingTime,
                cost: totalCost,
                totalTokens
            };
        } catch (error) {
            console.error('Error fetching usage data:', error);
            throw new Error(`Failed to fetch usage data: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    
    private formatRemainingTime(remainingTimeMs: number): string {
        const hours = Math.floor(remainingTimeMs / (60 * 60 * 1000));
        const minutes = Math.floor((remainingTimeMs % (60 * 60 * 1000)) / (60 * 1000));
        
        return `${hours}h ${minutes}m`;
    }
}