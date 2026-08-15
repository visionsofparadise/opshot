let transactionOpen = false;

export const isTransactionOpen = (): boolean => transactionOpen;

export const openTransaction = (): void => {
	transactionOpen = true;
};

export const closeTransaction = (): void => {
	transactionOpen = false;
};
