import type { ComponentProps } from 'react';
import { ChevronDownIcon } from './Icons';

export function AssistantSelect(props: ComponentProps<'select'>) {
  return <span className="assistant-select">
    <select {...props} />
    <ChevronDownIcon aria-hidden="true" />
  </span>;
}
