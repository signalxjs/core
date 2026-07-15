import { component } from 'sigx';

const roll = () => Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 6));

/**
 * The state-transfer proof. These dice are rolled ON THE SERVER, during
 * setup — so if hydration re-ran the roll, the numbers would change when
 * this island wakes up. They don't: the signal is auto-keyed "dice" by the
 * vite transform, the server captures the rolled values in this island's
 * boundary record, and hydration restores them instead of evaluating the
 * initial again. Only "re-roll" — real client interactivity — changes them.
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
