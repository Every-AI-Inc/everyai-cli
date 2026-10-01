import { describe, expect, it } from 'vitest';
import { parsePipelineStages, unknownStageMessage } from '../src/commands/aliases.js';

describe('deal stage helpers', () => {
  it('reads the ordered stage list from get_pipeline_settings', () => {
    const stages = parsePipelineStages({
      stages: [
        { key: 'lead', label: 'Lead', role: 'lead', criteria: 'x', agent_can_move_to_stage: true },
        { key: 'stage_1a2b3c4d', label: 'Discovery booked', role: 'middle', criteria: 'y' },
      ],
    });
    expect(stages.map((stage) => [stage.key, stage.label, stage.role])).toEqual([
      ['lead', 'Lead', 'lead'],
      ['stage_1a2b3c4d', 'Discovery booked', 'middle'],
    ]);
  });

  it('falls back to the four defaults from an older server settings map', () => {
    const stages = parsePipelineStages({
      result: {
        stages: {
          lead: { criteria: 'a', agent_can_move_to_stage: true },
          opportunity: { criteria: 'b', agent_can_move_to_stage: true },
          won: { criteria: 'c', agent_can_move_to_stage: false },
          lost: { criteria: 'd', agent_can_move_to_stage: true },
        },
      },
    });
    expect(stages.map((stage) => [stage.key, stage.label, stage.role])).toEqual([
      ['lead', 'Lead', 'lead'],
      ['opportunity', 'Opportunity', 'middle'],
      ['won', 'Won', 'won'],
      ['lost', 'Lost', 'lost'],
    ]);
    expect(stages[2].agent_can_move_to_stage).toBe(false);
  });

  it('builds the unknown-stage sentence from available_stages', () => {
    expect(
      unknownStageMessage('Negotiating', [
        { key: 'lead', label: 'Lead', role: 'lead' },
        { key: 'stage_1a2b3c4d', label: 'Discovery booked', role: 'middle' },
      ]),
    ).toBe('Unknown stage "Negotiating". Available stages: Lead, Discovery booked');
    expect(unknownStageMessage('x', undefined)).toBe(
      'Unknown stage "x". Available stages: run `every deal stages` to list them',
    );
  });
});
