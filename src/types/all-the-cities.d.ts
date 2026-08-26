declare module 'all-the-cities' {
  interface GeoNamesCity {
    cityId: number;
    name: string;
    country: string;
    adminCode: string;
    population: number;
    loc: { type: 'Point'; coordinates: [number, number] };
  }
  const cities: GeoNamesCity[];
  export default cities;
}
