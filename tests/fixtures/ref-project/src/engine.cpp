#include <vector>

void Physics::World::step(float dt) {
	integrate(dt);
}
