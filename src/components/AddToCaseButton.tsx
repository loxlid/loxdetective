import { useEffect, useState } from 'react';
import type { CaseEntity, ChainId } from '@/lib/types';
import { entityId, useCases } from '@/lib/cases/store';
import { useToast } from './Toast';

interface Props {
  chain: ChainId;
  kind: CaseEntity['kind'];
  /** Address (checksummed for EVM) or transaction hash. */
  value: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Adds / removes an entity in a case. Targets the active case (or the one
 * picked in the inline select when several exist); creates a case when none
 * exists yet.
 */
export default function AddToCaseButton({ chain, kind, value, size = 'md', className }: Props) {
  const cases = useCases((s) => s.cases);
  const activeCaseId = useCases((s) => s.activeCaseId);
  const addEntity = useCases((s) => s.addEntity);
  const removeEntity = useCases((s) => s.removeEntity);
  const createCase = useCases((s) => s.createCase);
  const setActive = useCases((s) => s.setActive);
  const toast = useToast();

  const [targetId, setTargetId] = useState<string | undefined>(activeCaseId ?? cases[0]?.id);
  useEffect(() => {
    if (!targetId || !cases.some((c) => c.id === targetId)) setTargetId(activeCaseId ?? cases[0]?.id);
  }, [cases, activeCaseId, targetId]);

  const target = cases.find((c) => c.id === targetId);
  const id = entityId(chain, kind, value);
  const inTarget = !!target?.entities.some((e) => e.id === id);
  const noun = kind === 'address' ? 'Address' : 'Transaction';

  const onClick = () => {
    if (!target) {
      const c = createCase('New case');
      setActive(c.id);
      addEntity(c.id, { chain, kind, value });
      setTargetId(c.id);
      toast.push(`${noun} added to new case "${c.title}"`, 'success');
      return;
    }
    if (inTarget) {
      removeEntity(target.id, id);
      toast.push(`${noun} removed from "${target.title}"`);
    } else {
      addEntity(target.id, { chain, kind, value });
      toast.push(`${noun} added to "${target.title}"`, 'success');
    }
  };

  return (
    <span className={`add-to-case${className ? ` ${className}` : ''}`}>
      {cases.length > 1 && (
        <select className="input input--select input--sm" value={targetId ?? ''} onChange={(e) => setTargetId(e.target.value)} aria-label="Target case">
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      )}
      <button type="button" className={`btn${size === 'sm' ? ' btn--sm' : ''}${inTarget ? ' btn--ghost is-active' : ''}`} onClick={onClick} title={inTarget ? 'Remove from case' : 'Add to case'}>
        {inTarget ? '✓ In case' : '+ Add to case'}
      </button>
    </span>
  );
}
