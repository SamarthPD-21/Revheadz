import { CLASSES, classTarget } from "../../lib/drag/classes";
import { getVehicle } from "../../lib/vehicles";
import { cardOf } from "../../lib/vehicles/garage";
import { Silhouette } from "../Silhouette";

/**
 * The lobby's class board, slowest class first: what each class runs a perfect quarter mile in,
 * and a few of the cars in it.
 */
export function ClassBoard() {
  return (
    <section className="class-board" aria-labelledby="class-board-title">
      <h2 id="class-board-title" className="class-board-title">
        Classes
      </h2>
      <p className="class-board-note">Perfect quarter-mile time for each class. You race cars in your own class.</p>
      <ol>
        {CLASSES.map((c) => {
          const target = classTarget(c);
          const cars = c.cars.map(getVehicle).filter((v) => v !== undefined);
          return (
            <li key={c.id} className="class-row">
              <div className="min-w-0">
                <h3>{c.name}</h3>
                <p>{c.blurb}</p>
              </div>
              <p className="class-time">
                {target ? (target / 1000).toFixed(2) : "–"}
                <span> s</span>
              </p>
              <div className="class-cars" aria-label={cars.map((v) => v.name).join(", ")}>
                {cars.slice(0, 3).map((v) => {
                  const card = cardOf(v);
                  return card ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={v.id} src={card} alt="" loading="lazy" />
                  ) : (
                    <Silhouette key={v.id} kind={v.ui.silhouette} accent="#a1a1aa" className="class-cars-sil" />
                  );
                })}
                {cars.length > 3 && <span className="class-more">+{cars.length - 3}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
