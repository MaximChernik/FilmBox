import { Routes } from '@angular/router';
import { CatalogComponent } from './features/catalog/catalog.component';
import { DetailsComponent } from './features/details/details.component';
import { LibraryComponent } from './features/library/library.component';
import { PlayerComponent } from './features/player/player.component';
import { RecsComponent } from './features/recs/recs.component';
import { SettingsComponent } from './features/settings/settings.component';

export const routes: Routes = [
  { path: '', component: CatalogComponent, data: { category: 'home' } },
  { path: 'category/:id', component: CatalogComponent },
  { path: 'search', component: CatalogComponent, data: { search: true } },
  { path: 'details', component: DetailsComponent },
  { path: 'watch', component: PlayerComponent },
  { path: 'recs', component: RecsComponent },
  { path: 'favorites', component: LibraryComponent },
  { path: 'later', component: LibraryComponent },
  { path: 'history', component: LibraryComponent },
  { path: 'follows', component: LibraryComponent },
  { path: 'library', redirectTo: 'favorites', pathMatch: 'full' },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: '' },
];
