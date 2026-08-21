import type { OperationPath } from "./path";

export const routeUnderPath = (route: OperationPath, formation: OperationPath): boolean => {
	if (route.length < formation.length) return false;

	for (let index = 0; index < formation.length; index++) {
		const routeSegment = route[index];
		const formationSegment = formation[index];

		if (routeSegment === undefined || formationSegment === undefined) return false;

		if (routeSegment !== formationSegment) return false;
	}

	return true;
};
