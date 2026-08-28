const Outer = () => {
	useEffect(() => {
		const deepHandler = () => 1;
	});
};
const Later = () => {
	useEffect(() => {
		const deepHandler = () => 2;
	});
};
