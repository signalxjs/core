import { component } from 'sigx';

const roll = () => Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 6));

/**
 * The state-transfer proof. These dice are rolled ON THE SERVER, during
 * setup. Setup runs again when the island hydrates — and rolls again — but
 * the signal is auto-keyed "dice" by the vite transform, so hydration seeds
 * it from the values captured in this island's boundary record and the
 * client's fresh roll is discarded: the numbers you see stay the server's.
 * Only "re-roll" — real client interactivity — changes them.
 */
export const ServerDice = component((ctx) => {
    const dice = ctx.signal({ rolls: roll() });
    return () => (
        <p>
            server rolled <strong>{dice.rolls.join(' · ')}</strong>{' '}
            — unchanged by hydration —{' '}
            <button onClick={() => { dice.rolls = roll(); }}>re-roll (client)</button>
        </p>
    );
}, { name: 'ServerDice' });
