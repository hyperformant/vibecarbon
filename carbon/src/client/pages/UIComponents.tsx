import {
  IconMinus as Minus,
  IconDotsVertical as MoreVertical,
  IconPlus as Plus,
} from '@tabler/icons-react';
import { useState } from 'react';
import { ContentPanel } from '../components/ContentPanel';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ButtonGroup } from '../components/ui/button-group';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';

export default function UIComponents() {
  const [gpuCount, setGpuCount] = useState(8);
  const [priceRange, setPriceRange] = useState([200, 800]);

  return (
    <>
      <PageHeader title="UI Components" />

      <ContentPanel variant="full">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Card Example */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground px-1.5 py-2">Card</p>
            <Card className="relative flex-1 pt-0">
              {/* Color overlay */}
              <div className="bg-primary absolute inset-0 z-30 aspect-video opacity-50 mix-blend-color" />
              {/* Image */}
              <img
                alt="Abstract green texture"
                className="relative z-20 aspect-video w-full object-cover brightness-[0.6] grayscale"
                src="https://images.unsplash.com/photo-1604076850742-4c7221f3101b?q=80&w=800&auto=format&fit=crop"
              />
              <CardHeader>
                <CardTitle>Observability Plus is replacing Monitoring</CardTitle>
                <CardDescription>
                  Switch to the improved way to explore your data, with natural language. Monitoring
                  will no longer be available on the Pro plan in November, 2025
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button>
                  Create Query <Plus data-icon="inline-end" />
                </Button>
                <Badge variant="secondary" className="ml-auto">
                  Warning
                </Badge>
              </CardFooter>
            </Card>
          </div>

          {/* Form Example */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground px-1.5 py-2">Form</p>
            <Card className="flex-1">
              <CardHeader>
                <CardTitle>User Information</CardTitle>
                <CardDescription>Please fill in your details below</CardDescription>
                <CardAction>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                      <MoreVertical />
                      <span className="sr-only">More options</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Edit</DropdownMenuItem>
                      <DropdownMenuItem>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
              </CardHeader>
              <CardContent>
                <form className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="name">Name</Label>
                      <Input id="name" placeholder="Enter your name" required />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="role">Role</Label>
                      <Select>
                        <SelectTrigger id="role" className="w-full">
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="framework">Framework</Label>
                    <Select>
                      <SelectTrigger id="framework" className="w-full">
                        <SelectValue placeholder="Select a framework" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="react">React</SelectItem>
                        <SelectItem value="vue">Vue</SelectItem>
                        <SelectItem value="svelte">Svelte</SelectItem>
                        <SelectItem value="angular">Angular</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="comments">Comments</Label>
                    <Textarea id="comments" placeholder="Add any additional comments" />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit">Submit</Button>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>

          {/* Fields Example */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground px-1.5 py-2">Fields</p>
            <div className="flex min-w-0 flex-1 items-start rounded-[var(--radius-card)] border border-dashed p-4 sm:p-6">
              <fieldset className="flex w-full max-w-md flex-col gap-4">
                {/* Radio Group Section */}
                <div className="flex flex-col gap-2">
                  <legend className="text-base font-medium">Compute Environment</legend>
                  <p className="text-sm text-muted-foreground">
                    Select the compute environment for your cluster.
                  </p>
                  <RadioGroup defaultValue="kubernetes" className="mt-2 gap-3">
                    <label
                      htmlFor="kubernetes"
                      className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-input p-4 has-[[data-checked]]:border-ring has-[[data-checked]]:bg-accent"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Kubernetes</span>
                        <p className="text-sm text-muted-foreground">
                          Run GPU workloads on a K8s configured cluster. This is the default.
                        </p>
                      </div>
                      <RadioGroupItem value="kubernetes" id="kubernetes" />
                    </label>
                    <label
                      htmlFor="vm"
                      className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-input p-4 has-[[data-checked]]:border-ring has-[[data-checked]]:bg-accent"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">Virtual Machine</span>
                        <p className="text-sm text-muted-foreground">
                          Access a VM configured cluster to run workloads. (Coming soon)
                        </p>
                      </div>
                      <RadioGroupItem value="vm" id="vm" />
                    </label>
                  </RadioGroup>
                </div>

                <Separator />

                {/* Number Input with Button Group */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="gpu-count">Number of GPUs</Label>
                    <p className="text-sm text-muted-foreground">You can add more later.</p>
                  </div>
                  <ButtonGroup>
                    <Input
                      id="gpu-count"
                      type="text"
                      value={gpuCount}
                      onChange={(e) => setGpuCount(Number(e.target.value) || 0)}
                      className="w-14 text-center"
                      maxLength={3}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setGpuCount(Math.max(0, gpuCount - 1))}
                      aria-label="Decrement"
                    >
                      <Minus />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setGpuCount(gpuCount + 1)}
                      aria-label="Increment"
                    >
                      <Plus />
                    </Button>
                  </ButtonGroup>
                </div>

                <Separator />

                {/* Switch */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="tinting">Wallpaper Tinting</Label>
                    <p className="text-sm text-muted-foreground">
                      Allow the wallpaper to be tinted.
                    </p>
                  </div>
                  <Switch id="tinting" defaultChecked />
                </div>

                <Separator />

                {/* Checkbox */}
                <label
                  htmlFor="terms"
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-input p-4 has-[[data-checked]]:border-ring has-[[data-checked]]:bg-accent"
                >
                  <Checkbox id="terms" defaultChecked />
                  <span className="font-normal">I agree to the terms and conditions</span>
                </label>

                {/* Slider */}
                <div className="flex flex-col gap-2">
                  <Label>Price Range</Label>
                  <p className="text-sm text-muted-foreground">
                    Set your budget range ($
                    <span className="font-medium tabular-nums">{priceRange[0]}</span> -{' '}
                    <span className="font-medium tabular-nums">{priceRange[1]}</span>).
                  </p>
                  <Slider
                    value={priceRange}
                    onValueChange={(value) => {
                      if (Array.isArray(value)) {
                        setPriceRange(value as number[]);
                      }
                    }}
                    min={0}
                    max={1000}
                    step={10}
                    className="mt-2"
                  />
                </div>

                {/* Buttons */}
                <div className="flex gap-2 pt-2">
                  <Button type="submit">Submit</Button>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </div>
          </div>

          {/* Complex Form Example */}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground px-1.5 py-2">Complex Form</p>
            <Card className="flex-1">
              <CardHeader>
                <CardTitle>Payment Method</CardTitle>
                <CardDescription>All transactions are secure and encrypted</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="flex flex-col gap-4">
                  {/* Card Details */}
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="card-name">Name on Card</Label>
                      <Input id="card-name" placeholder="John Doe" required />
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 flex flex-col gap-2">
                        <Label htmlFor="card-number">Card Number</Label>
                        <Input id="card-number" placeholder="1234 5678 9012 3456" required />
                        <p className="text-sm text-muted-foreground">Enter your 16-digit number.</p>
                      </div>
                      <div className="col-span-1 flex flex-col gap-2">
                        <Label htmlFor="cvv">CVV</Label>
                        <Input id="cvv" placeholder="123" required />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="exp-month">Month</Label>
                        <Select>
                          <SelectTrigger id="exp-month" className="w-full">
                            <SelectValue placeholder="MM" />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 12 }, (_, i) => {
                              const month = String(i + 1).padStart(2, '0');
                              return (
                                <SelectItem key={month} value={month}>
                                  {month}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="exp-year">Year</Label>
                        <Select>
                          <SelectTrigger id="exp-year" className="w-full">
                            <SelectValue placeholder="YYYY" />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 10 }, (_, i) => {
                              const year = String(2024 + i);
                              return (
                                <SelectItem key={year} value={year}>
                                  {year}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Billing Address */}
                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-base font-medium">Billing Address</legend>
                    <p className="text-sm text-muted-foreground">
                      The billing address associated with your payment.
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <Checkbox id="same-as-shipping" defaultChecked />
                      <Label htmlFor="same-as-shipping" className="font-normal">
                        Same as shipping address
                      </Label>
                    </div>
                  </fieldset>

                  <Separator />

                  {/* Comments */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="payment-comments">Comments</Label>
                    <Textarea id="payment-comments" placeholder="Add any additional comments" />
                  </div>

                  {/* Buttons */}
                  <div className="flex gap-2">
                    <Button type="submit">Submit</Button>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      </ContentPanel>
    </>
  );
}
