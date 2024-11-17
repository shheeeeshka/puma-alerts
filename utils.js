export const sleep = (sec = 0) => new Promise(resolve => setTimeout(resolve, sec * 1000));

export const getFormattedDate = () => {
    const now = new Date();
    return now.toISOString().replace(/:/g, '-').slice(0, 19); // 2023-10-03T15-30-45
}