import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Errors } from '../../common/api/app-error';
import { InjectDb, isUniqueViolation, type Database } from '../../database/database';
import { roadmapPhases, type RoadmapGoal } from '../../database/schema';

export type RoadmapPhase = { id: string; label: string; description: string; goals: RoadmapGoal[]; position: number };
export type PhaseInput = { label?: string; description?: string; goals?: { id?: string; text: string; done: boolean }[] };

const DEFAULT_PHASES = ['Phase 1', 'Phase 2', 'Phase 3'];
const MAX_PHASES = 50;

/** The phases on the console's /roadmap page, shared by every staff member. */
@Injectable()
export class RoadmapService {
  constructor(@InjectDb() private readonly db: Database) {}

  private view(row: { id: string; label: string; description?: string; goals?: RoadmapGoal[]; position: number }): RoadmapPhase {
    return { id: row.id, label: row.label, description: row.description ?? '', goals: row.goals ?? [], position: row.position };
  }

  /** Goals keep their ids; new ones get one. Blank lines are dropped. */
  private goals(input: PhaseInput['goals']): RoadmapGoal[] | undefined {
    if (!input) return undefined;
    return input
      .map((goal) => ({ id: goal.id || randomUUID(), text: goal.text.trim(), done: Boolean(goal.done) }))
      .filter((goal) => goal.text.length > 0);
  }

  /** Every phase in road order; an empty roadmap starts with Phase 1–3. */
  async list(): Promise<RoadmapPhase[]> {
    let rows = await this.db.find(roadmapPhases, {}, { sort: { position: 1, createdAt: 1 } });
    if (rows.length === 0) {
      // Positions are unique, so a second load seeding at the same moment adds nothing.
      await this.db.insertIgnoringDuplicates(
        roadmapPhases,
        DEFAULT_PHASES.map((label, position) => ({ label, position, description: '', goals: [] })),
      );
      rows = await this.db.find(roadmapPhases, {}, { sort: { position: 1, createdAt: 1 } });
    }
    return rows.map((row) => this.view(row));
  }

  /** A new phase at the end of the road. */
  async add(input: PhaseInput & { label: string }): Promise<RoadmapPhase> {
    const existing = await this.list();
    if (existing.length >= MAX_PHASES) throw Errors.conflict(`The roadmap holds up to ${MAX_PHASES} phases.`, 'ROADMAP_FULL');
    const position = existing.length ? Math.max(...existing.map((phase) => phase.position)) + 1 : 0;
    const values = { label: input.label, description: input.description?.trim() ?? '', goals: this.goals(input.goals) ?? [] };
    try {
      return this.view(await this.db.insert(roadmapPhases, { ...values, position }));
    } catch (error) {
      // Someone else added a phase at the same moment; take the next spot.
      if (!isUniqueViolation(error)) throw error;
      return this.view(await this.db.insert(roadmapPhases, { ...values, position: position + 1 }));
    }
  }

  /** Removes a phase; the ones after it move up a place so the road has no gap. */
  async remove(id: string): Promise<{ id: string }> {
    const row = await this.db.delete(roadmapPhases, { id });
    if (!row) throw Errors.notFound('That phase is no longer on the roadmap.', 'PHASE_NOT_FOUND');
    // Positions are unique, so close the gap from the front: each step lands on a freed spot.
    const after = await this.db.find(roadmapPhases, { position: { $gt: row.position } }, { sort: { position: 1 } });
    for (const phase of after) await this.db.update(roadmapPhases, { id: phase.id }, { position: phase.position - 1 });
    return { id };
  }

  /** Changes any of name, description and goals. */
  async update(id: string, input: PhaseInput): Promise<RoadmapPhase> {
    const patch: Partial<Pick<RoadmapPhase, 'label' | 'description' | 'goals'>> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description.trim();
    const goals = this.goals(input.goals);
    if (goals) patch.goals = goals;
    const row = await this.db.update(roadmapPhases, { id }, patch);
    if (!row) throw Errors.notFound('That phase is no longer on the roadmap.', 'PHASE_NOT_FOUND');
    return this.view(row);
  }
}
