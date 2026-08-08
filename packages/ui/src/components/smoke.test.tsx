// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@nos/ui/components/ui/button';
import { Badge } from '@nos/ui/components/ui/badge';
import { Input } from '@nos/ui/components/ui/input';
import { Switch } from '@nos/ui/components/ui/switch';
import { Slider } from '@nos/ui/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@nos/ui/components/ui/select';

describe('shadcn components under jsdom', () => {
  it('renders a button', () => {
    render(<Button>Snap</Button>);
    expect(screen.getByRole('button', { name: 'Snap' })).toBeTruthy();
  });

  it('renders a badge, an input, a switch and a slider', () => {
    render(
      <>
        <Badge>proxy</Badge>
        <Input aria-label="name" defaultValue="a" />
        <Switch aria-label="enabled" />
        <Slider aria-label="level" defaultValue={50} />
      </>,
    );
    expect(screen.getByText('proxy')).toBeTruthy();
    expect(screen.getByLabelText('name')).toBeTruthy();
    expect(screen.getByLabelText('enabled')).toBeTruthy();
  });

  it('renders a closed select', () => {
    render(
      <Select value="a">
        <SelectTrigger aria-label="pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByLabelText('pick')).toBeTruthy();
  });
});
