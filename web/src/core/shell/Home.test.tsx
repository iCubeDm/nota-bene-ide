// Issue 651: the home page keeps the app's frame, with only the parts that say they show there (`on`).
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { definePlugin } from '@/sdk';
import { setLang } from '@/core/i18n/index.ts';
import { makeStore } from '@/core/testing';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { Frame } from './Frame.tsx';
import { Home } from './Home.tsx';

const part = (name: string) => () => <span data-part={name} />;
const PLUGIN = definePlugin({
  id: 'test',
  slots: [
    { slot: 'header.end', order: 10, render: part('agent-only') },
    { slot: 'strip.left', order: 10, render: part('home-strip'), on: 'home' },
    { slot: 'home', order: 10, render: part('home-centre'), on: 'home' },
    { slot: 'overlay', order: 10, render: part('both'), on: 'both' },
  ],
});
const store = () => makeStore({ url: 'ws://test', plugins: [PLUGIN], socket: false });
const has = (name: string) => document.querySelector(`[data-part="${name}"]`) !== null;

beforeEach(() => setLang('en'));
afterEach(cleanup);

it('the home page shows the frame with only the parts that show there', () => {
  render(<Provider store={store()}><Home /></Provider>);
  expect(screen.getByRole('banner')).toBeTruthy();
  expect(has('home-centre')).toBe(true);
  expect(has('both')).toBe(true);
  expect(has('agent-only')).toBe(false);
  expect(document.querySelector('nav[data-strip="left"] [data-part="home-strip"]')).not.toBeNull();
});

it('an agent page leaves out the home parts', () => {
  render(<Provider store={store()}><TooltipProvider><Frame center={null} /></TooltipProvider></Provider>);
  expect(has('agent-only')).toBe(true);
  expect(has('both')).toBe(true);
  expect(has('home-centre')).toBe(false);
  expect(has('home-strip')).toBe(false);
});
