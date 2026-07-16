import {
	createGameWorld,
	GameWorldTraits,
} from "../../../packages/engine/dist/index.js";

const game = createGameWorld();
const traits = Object.values(GameWorldTraits);
const entity = game.world.spawn(...traits);

for (const trait of traits) {
	if (!entity.has(trait)) {
		throw new Error("spawned entity is missing an initialized Phase 04 trait");
	}
}

game.destroy();
